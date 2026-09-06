import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { JobRepository, type JobStore } from '../db/jobs';
import { ProjectLanguageRepository, type ProjectLanguageStore } from '../db/project-languages';
import { SegmentRepository, type SegmentStore } from '../db/segments';
import { SegmentTranslationRepository } from '../db/segment-translations';
import {
  ProjectExportRepository,
  type ProjectExport,
} from '../db/project-exports';
import {
  isTargetLanguage,
  type ExportOutput,
  type TargetLanguage,
} from '../domain/language';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { errorBody } from '../http/json';
import { MediaObjectNotFoundError, streamMediaObject } from '../http/media-stream';
import { createTelemetry, emitTelemetry } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { ElevenLabsVoiceProvider } from '../services/voice/elevenlabs';
import type { VoiceCapabilities } from '../services/voice/types';

const EXPORT_OUTPUTS = new Set<ExportOutput>(['dubbed', 'subtitles']);

type VariantStore = Pick<SegmentTranslationRepository, 'list'>;
type ExportStore = Pick<ProjectExportRepository, 'create' | 'latest' | 'fail'>;

export type ExportRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeJobs?: (env: Env) => JobStore;
  makeBucket?: (env: Env) => R2ReadableBucketLike;
  makeLanguages?: (env: Env) => ProjectLanguageStore;
  makeSegments?: (env: Env) => Pick<SegmentStore, 'list'>;
  makeVariants?: (env: Env) => VariantStore;
  makeExports?: (env: Env) => ExportStore;
  getVoiceCapabilities?: (env: Env) => VoiceCapabilities;
};

type LaunchValidation = {
  project: Awaited<ReturnType<ProjectStore['getByIdForUser']>> & {};
  targetLanguage: TargetLanguage;
  output: ExportOutput;
};

type LaunchResult = {
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  exportId: string;
  jobId: string;
  workflowId?: string;
  status: 'queued' | 'failed';
  errorCode?: string;
  errorMessage?: string;
};

function voiceConfigured(env: Env) {
  return Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_DEFAULT_VOICE_ID?.trim());
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

function defaultVoiceCapabilities(env: Env): VoiceCapabilities {
  return new ElevenLabsVoiceProvider(
    env.ELEVENLABS_API_KEY ?? '',
    { defaultVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID },
  ).capabilities();
}

function outputFrom(value: unknown): ExportOutput | null {
  return typeof value === 'string' && EXPORT_OUTPUTS.has(value as ExportOutput)
    ? value as ExportOutput
    : null;
}

function targetFrom(value: unknown): TargetLanguage | null {
  return isTargetLanguage(value) ? value : null;
}

function workflowParams(
  projectId: string,
  userId: string,
  jobId: string,
  exportId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput,
  requestId?: string,
) {
  return {
    projectId,
    userId,
    jobId,
    exportId,
    targetLanguage,
    output,
    ...(requestId ? { requestId } : {}),
  };
}

export function createExportRoutes(deps: ExportRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeBucket = deps.makeBucket ?? readableBucket;
  const makeLanguages = deps.makeLanguages ?? ((env: Env) => new ProjectLanguageRepository(env.DB));
  const makeSegments = deps.makeSegments ?? ((env: Env) => new SegmentRepository(env.DB));
  const makeVariants = deps.makeVariants ?? ((env: Env) => new SegmentTranslationRepository(env.DB));
  const makeExports = deps.makeExports ?? ((env: Env) => new ProjectExportRepository(env.DB));
  const getVoiceCapabilities = deps.getVoiceCapabilities ?? defaultVoiceCapabilities;

  // Older unit harnesses intentionally omit D1. Keep that compatibility path while
  // production and Phase 4C harnesses use durable per-language export attempts.
  const useLegacyHarness = (env: Env) => !env.DB
    && !deps.makeLanguages
    && !deps.makeSegments
    && !deps.makeVariants
    && !deps.makeExports
    && !deps.getVoiceCapabilities;

  async function validateLaunch(
    c: any,
    projectId: string,
    targetLanguage: TargetLanguage,
    output: ExportOutput,
  ): Promise<LaunchValidation | Response> {
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!project.sourceObjectKey) {
      return c.json(errorBody('SOURCE_MEDIA_REQUIRED', 'Upload source media before export.'), 400);
    }
    if (!['needs_review', 'completed'].includes(project.status)) {
      return c.json(errorBody('PROJECT_NOT_EXPORTABLE', 'Project must finish dubbing review before export.'), 409);
    }

    const config = await makeLanguages(c.env).getConfig(projectId, userId);
    if (!config) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!config.languages.some((entry) => entry.targetLanguage === targetLanguage)) {
      return c.json(errorBody('PROJECT_LANGUAGE_NOT_ENABLED', 'Target language is not enabled for this project.'), 409);
    }

    const [canonical, variants] = await Promise.all([
      makeSegments(c.env).list(projectId, userId),
      makeVariants(c.env).list(projectId, userId, targetLanguage),
    ]);
    if (canonical.length === 0) {
      return c.json(errorBody('TRANSLATION_VARIANTS_INCOMPLETE', 'No canonical segments are available for export.'), 409);
    }
    const bySegment = new Map(variants.map((row) => [row.segmentId, row]));
    const incomplete = canonical.some((segment) => {
      const variant = bySegment.get(segment.id);
      return !variant
        || variant.translationStatus !== 'completed'
        || !variant.translatedText.trim();
    });
    if (incomplete || variants.length !== canonical.length) {
      return c.json(errorBody(
        'TRANSLATION_VARIANTS_INCOMPLETE',
        'Every canonical segment must have a completed non-empty translation for this target.',
      ), 409);
    }

    if (output === 'dubbed') {
      const capability = getVoiceCapabilities(c.env);
      if (capability.configured === false) {
        return c.json(errorBody(
          'VOICE_PROVIDER_UNCONFIGURED',
          'Voice provider credentials are required before dubbed export.',
        ), 503);
      }
      if (capability.languages === 'unknown') {
        return c.json(errorBody(
          'VOICE_LANGUAGE_UNQUALIFIED',
          'Voice language capability is unknown for this target.',
        ), 409);
      }
      if (!capability.languages.includes(targetLanguage)) {
        return c.json(errorBody(
          'VOICE_LANGUAGE_UNSUPPORTED',
          'Voice provider is not qualified for this target language.',
        ), 400);
      }
    }

    return { project, targetLanguage, output };
  }

  async function launchAttempt(
    c: any,
    validated: LaunchValidation,
    batchId: string | null,
  ): Promise<LaunchResult> {
    const userId = getCurrentUserId();
    const projectId = validated.project.id;
    const exportsStore = makeExports(c.env);
    const jobs = makeJobs(c.env);
    const attempt = await exportsStore.create(
      projectId,
      userId,
      validated.targetLanguage,
      validated.output,
      batchId,
    );
    const job = await jobs.create(projectId, `export:${validated.targetLanguage}:${validated.output}`);

    try {
      const instance = await c.env.EXPORT_WORKFLOW.create({
        params: workflowParams(
          projectId,
          userId,
          job.id,
          attempt.id,
          validated.targetLanguage,
          validated.output,
          c.get('requestId'),
        ),
      });
      return {
        targetLanguage: validated.targetLanguage,
        output: validated.output,
        exportId: attempt.id,
        jobId: job.id,
        workflowId: instance.id,
        status: 'queued',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start export Workflow.';
      await exportsStore.fail(projectId, attempt.id, userId, 'EXPORT_WORKFLOW_START_FAILED', message);
      await jobs.fail(job.id, 'EXPORT_WORKFLOW_START_FAILED', message);
      return {
        targetLanguage: validated.targetLanguage,
        output: validated.output,
        exportId: attempt.id,
        jobId: job.id,
        status: 'failed',
        errorCode: 'EXPORT_WORKFLOW_START_FAILED',
        errorMessage: message,
      };
    }
  }

  async function launchSingle(
    c: any,
    projectId: string,
    targetLanguage: TargetLanguage,
    output: ExportOutput,
  ) {
    const validated = await validateLaunch(c, projectId, targetLanguage, output);
    if (validated instanceof Response) return validated;

    const rateLimited = await enforceRateLimit(c, 'export', getCurrentUserId(), projectId);
    if (rateLimited) return rateLimited;

    const result = await launchAttempt(c, validated, null);
    if (result.status === 'failed') {
      return c.json(errorBody(
        result.errorCode ?? 'EXPORT_WORKFLOW_START_FAILED',
        result.errorMessage ?? 'Unable to start export Workflow.',
      ), 503);
    }
    return c.json({
      jobId: result.jobId,
      workflowId: result.workflowId,
      exportId: result.exportId,
      targetLanguage: result.targetLanguage,
      output: result.output,
      status: 'queued' as const,
    }, 202);
  }

  routes.post('/:id/exports/batch', async (c) => {
    const projectId = c.req.param('id');
    let input: { targetLanguages?: unknown; output?: unknown };
    try {
      input = await c.req.json();
    } catch {
      return c.json(errorBody('EXPORT_REQUEST_INVALID', 'Request body must contain valid JSON.'), 400);
    }
    const output = outputFrom(input.output);
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Export output must be dubbed or subtitles.'), 400);
    if (!Array.isArray(input.targetLanguages) || input.targetLanguages.length === 0) {
      return c.json(errorBody('EXPORT_TARGETS_INVALID', 'At least one target language is required.'), 400);
    }
    if (input.targetLanguages.some((target) => !isTargetLanguage(target))) {
      return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    }
    const targets = input.targetLanguages as TargetLanguage[];
    if (new Set(targets).size !== targets.length) {
      return c.json(errorBody('EXPORT_TARGETS_INVALID', 'Target languages must be unique.'), 400);
    }

    const validated: LaunchValidation[] = [];
    for (const target of targets) {
      const result = await validateLaunch(c, projectId, target, output);
      if (result instanceof Response) return result;
      validated.push(result);
    }

    const rateLimited = await enforceRateLimit(c, 'export', getCurrentUserId(), projectId);
    if (rateLimited) return rateLimited;

    const batchId = crypto.randomUUID();
    const launches: LaunchResult[] = [];
    for (const target of validated) {
      launches.push(await launchAttempt(c, target, batchId));
    }
    return c.json({ batchId, exports: launches }, 202);
  });

  routes.post('/:id/exports/:language', async (c) => {
    const targetLanguage = targetFrom(c.req.param('language'));
    if (!targetLanguage) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    let input: { output?: unknown };
    try {
      input = await c.req.json();
    } catch {
      return c.json(errorBody('EXPORT_REQUEST_INVALID', 'Request body must contain valid JSON.'), 400);
    }
    const output = outputFrom(input.output);
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Export output must be dubbed or subtitles.'), 400);
    return launchSingle(c, c.req.param('id'), targetLanguage, output);
  });

  routes.get('/:id/exports/:language/media', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    const targetLanguage = targetFrom(c.req.param('language'));
    if (!targetLanguage) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    const output = outputFrom(c.req.query('output') ?? 'dubbed');
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Export output must be dubbed or subtitles.'), 400);

    const latest = await makeExports(c.env).latest(projectId, userId, targetLanguage, output);
    if (!latest || latest.status !== 'completed') {
      return c.json(errorBody('EXPORT_NOT_READY', 'Requested export is not ready.'), 409);
    }
    const objectKey = output === 'subtitles' ? latest.subtitleObjectKey : latest.exportObjectKey;
    if (!objectKey) return c.json(errorBody('EXPORT_NOT_READY', 'Requested export object is not ready.'), 409);

    try {
      const extension = output === 'subtitles' ? 'srt' : 'mp4';
      const response = await streamMediaObject(
        makeBucket(c.env),
        objectKey,
        c.req.raw,
        `${projectId}-${targetLanguage}-${output}.${extension}`,
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

  routes.get('/:id/exports/:language', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    const targetLanguage = targetFrom(c.req.param('language'));
    if (!targetLanguage) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    const output = outputFrom(c.req.query('output') ?? 'dubbed');
    if (!output) return c.json(errorBody('EXPORT_OUTPUT_INVALID', 'Export output must be dubbed or subtitles.'), 400);
    const latest = await makeExports(c.env).latest(projectId, userId, targetLanguage, output);
    if (!latest) return c.json(errorBody('EXPORT_NOT_FOUND', 'Export attempt not found.'), 404);
    return c.json(latest);
  });

  routes.post('/:id/export', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');

    if (!useLegacyHarness(c.env)) {
      return launchSingle(c, projectId, 'vi', 'dubbed');
    }

    const projects = makeProjects(c.env);
    const jobs = makeJobs(c.env);
    try {
      const project = await projects.getByIdForUser(projectId, userId);
      if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      if (!project.sourceObjectKey) return c.json(errorBody('SOURCE_MEDIA_REQUIRED', 'Upload source media before export.'), 400);
      if (!['needs_review', 'completed'].includes(project.status)) {
        return c.json(errorBody('PROJECT_NOT_EXPORTABLE', 'Project must finish dubbing review before export.'), 409);
      }
      if (!voiceConfigured(c.env)) {
        return c.json(errorBody('VOICE_PROVIDER_UNCONFIGURED', 'ElevenLabs voice credentials are required before export.'), 503);
      }

      const rateLimited = await enforceRateLimit(c, 'export', userId, projectId);
      if (rateLimited) return rateLimited;

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
    } catch {
      return c.json(errorBody('EXPORT_START_FAILED', 'Unable to start final dubbing export.'), 500);
    }
  });

  routes.get('/:id/export/media', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    let objectKey = project.exportObjectKey;
    if (!useLegacyHarness(c.env)) {
      const latest = await makeExports(c.env).latest(projectId, userId, 'vi', 'dubbed');
      if (latest?.status === 'completed' && latest.exportObjectKey) objectKey = latest.exportObjectKey;
    }
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
