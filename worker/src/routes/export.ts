import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import { ProjectLanguageRepository, type ProjectLanguageStore } from '../db/project-languages';
import { ProjectExportRepository, type ProjectExport } from '../db/project-exports';
import { SegmentRepository, type SegmentStore } from '../db/segments';
import { SegmentTranslationRepository, type SegmentTranslation } from '../db/segment-translations';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { isTargetLanguage, type ExportOutput, type TargetLanguage } from '../domain/language';
import { errorBody } from '../http/json';
import { MediaObjectNotFoundError, streamMediaObject } from '../http/media-stream';
import { createTelemetry, emitTelemetry } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { ElevenLabsVoiceProvider } from '../services/voice/elevenlabs';
import type { VoiceCapabilities } from '../services/voice/types';

export type ExportStore = Pick<ProjectExportRepository, 'create' | 'latest' | 'latestCompleted' | 'fail'>;

export type ExportRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
  makeLanguages?: (env: Env) => Pick<ProjectLanguageStore, 'getConfig'>;
  makeSegments?: (env: Env) => Pick<SegmentStore, 'list'>;
  makeVariants?: (env: Env) => Pick<SegmentTranslationRepository, 'list'>;
  makeExports?: (env: Env) => ExportStore;
  makeBucket?: (env: Env) => R2ReadableBucketLike;
  getVoiceCapabilities?: (env: Env) => VoiceCapabilities;
  makeBatchId?: () => string;
};

type ExportValidationError = {
  status: 400 | 404 | 409 | 503;
  code: string;
  message: string;
};

type ValidatedTarget = {
  project: Awaited<ReturnType<ProjectStore['getByIdForUser']>> & {};
  targetLanguage: TargetLanguage;
  output: ExportOutput;
};

function voiceCapabilities(env: Env): VoiceCapabilities {
  return new ElevenLabsVoiceProvider(
    env.ELEVENLABS_API_KEY ?? '',
    { defaultVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID },
  ).capabilities();
}

function readableBucket(env: Env): R2ReadableBucketLike {
  return {
    async head(key) {
      if (!env.MEDIA.head) return null;
      return env.MEDIA.head(key);
    },
    async get(key, options) {
      if (!env.MEDIA.get) return null;
      return env.MEDIA.get(key, options);
    },
  };
}

function parseOutput(value: unknown): ExportOutput | null {
  return value === 'dubbed' || value === 'subtitles' ? value : null;
}

function voiceTargetError(capabilities: VoiceCapabilities, targetLanguage: TargetLanguage): ExportValidationError | null {
  if (capabilities.configured === false) {
    return {
      status: 503,
      code: 'VOICE_PROVIDER_UNCONFIGURED',
      message: 'The dubbing voice provider is not configured.',
    };
  }
  if (capabilities.languages === 'unknown') {
    return {
      status: 409,
      code: 'VOICE_LANGUAGE_UNQUALIFIED',
      message: `Voice language capability for ${targetLanguage} is not qualified.`,
    };
  }
  if (!capabilities.languages.includes(targetLanguage)) {
    return {
      status: 400,
      code: 'VOICE_LANGUAGE_UNSUPPORTED',
      message: `The configured voice provider does not support ${targetLanguage}.`,
    };
  }
  return null;
}

function translationsComplete(
  sourceSegments: Array<{ id: string }>,
  variants: SegmentTranslation[],
): boolean {
  if (sourceSegments.length === 0 || variants.length !== sourceSegments.length) return false;
  const bySegment = new Map(variants.map((variant) => [variant.segmentId, variant]));
  return sourceSegments.every((segment) => {
    const variant = bySegment.get(segment.id);
    return Boolean(
      variant
      && variant.translationStatus === 'completed'
      && variant.translatedText.trim(),
    );
  });
}

function isEnabled(
  config: Awaited<ReturnType<Pick<ProjectLanguageStore, 'getConfig'>['getConfig']>>,
  targetLanguage: TargetLanguage,
): boolean {
  return Boolean(config?.languages.some((entry) => entry.targetLanguage === targetLanguage));
}

function completedMediaKey(attempt: ProjectExport, output: ExportOutput): string | null {
  if (attempt.status !== 'completed') return null;
  return output === 'subtitles' ? attempt.subtitleObjectKey : attempt.exportObjectKey;
}

export function createExportRoutes(deps: ExportRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeLanguages = deps.makeLanguages ?? ((env: Env) => new ProjectLanguageRepository(env.DB));
  const makeSegments = deps.makeSegments ?? ((env: Env) => new SegmentRepository(env.DB));
  const makeVariants = deps.makeVariants ?? ((env: Env) => new SegmentTranslationRepository(env.DB));
  const makeExports = deps.makeExports ?? ((env: Env) => new ProjectExportRepository(env.DB));
  const makeBucket = deps.makeBucket ?? readableBucket;
  const getVoiceCapabilities = deps.getVoiceCapabilities ?? voiceCapabilities;
  const makeBatchId = deps.makeBatchId ?? (() => crypto.randomUUID());
  const voiceConfigured = (env: Env) => getVoiceCapabilities(env).configured !== false;

  async function validateTarget(
    env: Env,
    projectId: string,
    userId: string,
    rawLanguage: string,
    output: ExportOutput,
  ): Promise<ValidatedTarget | ExportValidationError> {
    const project = await makeProjects(env).getByIdForUser(projectId, userId);
    if (!project) return { status: 404, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
    if (!isTargetLanguage(rawLanguage)) {
      return { status: 400, code: 'TARGET_LANGUAGE_UNSUPPORTED', message: 'Unsupported target language.' };
    }
    const targetLanguage = rawLanguage;
    if (!project.sourceObjectKey && output === 'dubbed') {
      return { status: 400, code: 'SOURCE_MEDIA_REQUIRED', message: 'Upload source media before dubbed export.' };
    }
    if (!['needs_review', 'completed'].includes(project.status)) {
      return { status: 409, code: 'PROJECT_NOT_EXPORTABLE', message: 'Project must finish dubbing review before export.' };
    }

    const config = await makeLanguages(env).getConfig(projectId, userId);
    if (!config) return { status: 404, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' };
    if (!isEnabled(config, targetLanguage)) {
      return {
        status: 409,
        code: 'PROJECT_LANGUAGE_NOT_ENABLED',
        message: `Target language ${targetLanguage} is not enabled for this project.`,
      };
    }

    const [sourceSegments, variants] = await Promise.all([
      makeSegments(env).list(projectId, userId),
      makeVariants(env).list(projectId, userId, targetLanguage),
    ]);
    if (!translationsComplete(sourceSegments, variants)) {
      return {
        status: 409,
        code: 'TRANSLATION_VARIANTS_INCOMPLETE',
        message: `Completed non-empty ${targetLanguage} translations are required before export.`,
      };
    }

    if (output === 'dubbed') {
      const voiceError = voiceTargetError(getVoiceCapabilities(env), targetLanguage);
      if (voiceError) return voiceError;
    }
    return { project, targetLanguage, output };
  }

  async function launchValidated(
    env: Env,
    projectId: string,
    userId: string,
    targetLanguage: TargetLanguage,
    output: ExportOutput,
    batchId: string | null,
    requestId: string | undefined,
    legacy: boolean,
  ) {
    const exportsStore = makeExports(env);
    const jobs = makeJobs(env);
    const attempt = await exportsStore.create(projectId, userId, targetLanguage, output, batchId);
    const job = await jobs.create(projectId, legacy ? 'export' : `export:${targetLanguage}:${output}`);
    if (legacy) await makeProjects(env).setStatus(projectId, userId, 'processing');
    try {
      const instance = await env.EXPORT_WORKFLOW.create({
        params: {
          projectId,
          userId,
          jobId: job.id,
          exportId: attempt.id,
          targetLanguage,
          output,
          requestId,
        },
      });
      return {
        targetLanguage,
        output,
        exportId: attempt.id,
        jobId: job.id,
        workflowId: instance.id,
        status: 'queued' as const,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start export Workflow.';
      await jobs.fail(job.id, 'EXPORT_WORKFLOW_START_FAILED', message);
      await exportsStore.fail(projectId, attempt.id, userId, 'EXPORT_WORKFLOW_START_FAILED', message);
      if (legacy) await makeProjects(env).setStatus(projectId, userId, 'needs_review');
      return {
        targetLanguage,
        output,
        exportId: attempt.id,
        jobId: job.id,
        status: 'failed' as const,
        code: 'EXPORT_WORKFLOW_START_FAILED',
        message,
      };
    }
  }

  async function startSingle(c: any, targetLanguage: string, output: ExportOutput, legacy: boolean) {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    try {
      const validated = await validateTarget(c.env, projectId, userId, targetLanguage, output);
      if ('code' in validated) return c.json(errorBody(validated.code, validated.message), validated.status);

      const rateLimited = await enforceRateLimit(c, 'export', userId, projectId);
      if (rateLimited) return rateLimited;

      const launched = await launchValidated(
        c.env,
        projectId,
        userId,
        validated.targetLanguage,
        output,
        null,
        c.get('requestId'),
        legacy,
      );
      if (launched.status === 'failed') {
        return c.json(errorBody(launched.code, launched.message), 503);
      }
      if (legacy) {
        return c.json({ jobId: launched.jobId, workflowId: launched.workflowId, status: 'queued' as const }, 202);
      }
      return c.json(launched, 202);
    } catch {
      return c.json(errorBody('EXPORT_START_FAILED', 'Unable to start export.'), 500);
    }
  }

  async function startLegacy(c: any) {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const projects = makeProjects(c.env);
    const project = await projects.getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!project.sourceObjectKey) return c.json(errorBody('SOURCE_MEDIA_REQUIRED', 'Upload source media before export.'), 400);
    if (!['needs_review', 'completed'].includes(project.status)) {
      return c.json(errorBody('PROJECT_NOT_EXPORTABLE', 'Project must finish dubbing review before export.'), 409);
    }
    if (!voiceConfigured(c.env)) {
      return c.json(errorBody('VOICE_PROVIDER_UNCONFIGURED', 'The dubbing voice provider is not configured.'), 503);
    }

    const hasPhase4CLegacyState = Boolean(
      c.env.DB
      || (deps.makeLanguages && deps.makeSegments && deps.makeVariants && deps.makeExports),
    );
    if (hasPhase4CLegacyState) {
      const validated = await validateTarget(c.env, projectId, userId, 'vi', 'dubbed');
      if ('code' in validated) return c.json(errorBody(validated.code, validated.message), validated.status);
    }

    const rateLimited = await enforceRateLimit(c, 'export', userId, projectId);
    if (rateLimited) return rateLimited;

    const jobs = makeJobs(c.env);
    if (!hasPhase4CLegacyState) {
      const job = await jobs.create(projectId, 'export');
      await projects.setStatus(projectId, userId, 'processing');
      try {
        const instance = await c.env.EXPORT_WORKFLOW.create({
          params: { projectId, userId, jobId: job.id },
        });
        return c.json({ jobId: job.id, workflowId: instance.id, status: 'queued' as const }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to start export Workflow.';
        await jobs.fail(job.id, 'EXPORT_WORKFLOW_START_FAILED', message);
        await projects.setStatus(projectId, userId, 'needs_review');
        return c.json(errorBody('EXPORT_WORKFLOW_START_FAILED', message), 503);
      }
    }

    const exportsStore = makeExports(c.env);
    const attempt = await exportsStore.create(projectId, userId, 'vi', 'dubbed', null);
    const job = await jobs.create(projectId, 'export');
    await projects.setStatus(projectId, userId, 'processing');
    try {
      const instance = await c.env.EXPORT_WORKFLOW.create({
        params: {
          projectId,
          userId,
          jobId: job.id,
          exportId: attempt.id,
          targetLanguage: 'vi',
          output: 'dubbed',
          requestId: c.get('requestId'),
        },
      });
      return c.json({ jobId: job.id, workflowId: instance.id, status: 'queued' as const }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start export Workflow.';
      await jobs.fail(job.id, 'EXPORT_WORKFLOW_START_FAILED', message);
      await exportsStore.fail(projectId, attempt.id, userId, 'EXPORT_WORKFLOW_START_FAILED', message);
      await projects.setStatus(projectId, userId, 'needs_review');
      return c.json(errorBody('EXPORT_WORKFLOW_START_FAILED', message), 503);
    }
  }

  routes.post('/:id/exports/batch', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    let payload: { targetLanguages?: unknown; output?: unknown };
    try {
      payload = await c.req.json();
    } catch {
      return c.json(errorBody('EXPORT_REQUEST_INVALID', 'Export body must be valid JSON.'), 400);
    }
    const output = parseOutput(payload.output);
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Output must be dubbed or subtitles.'), 400);
    if (!Array.isArray(payload.targetLanguages) || payload.targetLanguages.length === 0) {
      return c.json(errorBody('EXPORT_TARGETS_INVALID', 'At least one target language is required.'), 400);
    }
    if (payload.targetLanguages.some((target) => !isTargetLanguage(target))) {
      return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'One or more target languages are unsupported.'), 400);
    }
    const targets = payload.targetLanguages as TargetLanguage[];
    if (new Set(targets).size !== targets.length) {
      return c.json(errorBody('EXPORT_TARGETS_INVALID', 'Batch target languages must be unique.'), 400);
    }

    const validated: TargetLanguage[] = [];
    for (const target of targets) {
      const result = await validateTarget(c.env, projectId, userId, target, output);
      if ('code' in result) return c.json(errorBody(result.code, result.message), result.status);
      validated.push(result.targetLanguage);
    }

    const rateLimited = await enforceRateLimit(c, 'export', userId, projectId);
    if (rateLimited) return rateLimited;

    const batchId = makeBatchId();
    const results = [];
    for (const target of validated) {
      results.push(await launchValidated(
        c.env,
        projectId,
        userId,
        target,
        output,
        batchId,
        c.get('requestId'),
        false,
      ));
    }
    return c.json({ batchId, exports: results }, 202);
  });

  routes.post('/:id/exports/:language', async (c) => {
    let payload: { output?: unknown };
    try {
      payload = await c.req.json();
    } catch {
      return c.json(errorBody('EXPORT_REQUEST_INVALID', 'Export body must be valid JSON.'), 400);
    }
    const output = parseOutput(payload.output);
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Output must be dubbed or subtitles.'), 400);
    return startSingle(c, c.req.param('language'), output, false);
  });

  routes.get('/:id/exports/:language', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const targetLanguage = c.req.param('language');
    if (!isTargetLanguage(targetLanguage)) {
      return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Unsupported target language.'), 400);
    }
    const output = parseOutput(c.req.query('output') ?? 'dubbed');
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Output must be dubbed or subtitles.'), 400);
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    const attempt = await makeExports(c.env).latest(projectId, userId, targetLanguage, output);
    if (!attempt) return c.json(errorBody('EXPORT_NOT_FOUND', 'No export attempt exists for this target/output.'), 404);
    return c.json(attempt);
  });

  routes.get('/:id/exports/:language/media', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const targetLanguage = c.req.param('language');
    if (!isTargetLanguage(targetLanguage)) {
      return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Unsupported target language.'), 400);
    }
    const output = parseOutput(c.req.query('output') ?? 'dubbed');
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Output must be dubbed or subtitles.'), 400);
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    const attempt = await makeExports(c.env).latestCompleted(projectId, userId, targetLanguage, output);
    const objectKey = attempt ? completedMediaKey(attempt, output) : null;
    if (!objectKey) return c.json(errorBody('EXPORT_NOT_READY', 'Requested export is not completed.'), 409);

    try {
      const response = await streamMediaObject(
        makeBucket(c.env),
        objectKey,
        c.req.raw,
        `${project.id}-${targetLanguage}.${output === 'subtitles' ? 'srt' : 'mp4'}`,
      );
      emitTelemetry(createTelemetry(c.env), {
        name: 'export_download',
        requestId: c.get('requestId'),
        actorId: userId,
        projectId,
        accessMode: 'owner',
        httpStatus: response.status,
        rangeRequest: Boolean(c.req.header('range')),
        status: response.status < 400 ? 'success' : 'rejected',
      });
      return response;
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) {
        return c.json(errorBody('EXPORT_OBJECT_NOT_FOUND', 'Export object not found.'), 404);
      }
      throw error;
    }
  });

  routes.post('/:id/export', async (c) => startLegacy(c));

  routes.get('/:id/export/media', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    let objectKey: string | null = null;
    try {
      const latest = await makeExports(c.env).latestCompleted(projectId, userId, 'vi', 'dubbed');
      objectKey = latest ? completedMediaKey(latest, 'dubbed') : null;
    } catch {
      // Legacy fallback remains readable while old project-level export state is reconciled.
    }
    objectKey ??= project.exportObjectKey ?? null;
    if (!objectKey) return c.json(errorBody('EXPORT_NOT_READY', 'Final dubbing export is not ready.'), 409);

    try {
      const response = await streamMediaObject(
        makeBucket(c.env),
        objectKey,
        c.req.raw,
        `${project.id}-dubbed.mp4`,
      );
      emitTelemetry(createTelemetry(c.env), {
        name: 'export_download',
        requestId: c.get('requestId'),
        actorId: userId,
        projectId,
        accessMode: 'owner',
        httpStatus: response.status,
        rangeRequest: Boolean(c.req.header('range')),
        status: response.status < 400 ? 'success' : 'rejected',
      });
      return response;
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) {
        return c.json(errorBody('EXPORT_OBJECT_NOT_FOUND', 'Final export object not found.'), 404);
      }
      throw error;
    }
  });

  return routes;
}
