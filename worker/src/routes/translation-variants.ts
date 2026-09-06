import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { SegmentRepository, type SegmentStore } from '../db/segments';
import {
  SegmentTranslationPersistenceError,
  SegmentTranslationRepository,
  type SegmentTranslation,
} from '../db/segment-translations';
import { ProjectLanguageRepository, type ProjectLanguageStore } from '../db/project-languages';
import { JobRepository, type JobStore } from '../db/jobs';
import { TranslationContextRepository, type TranslationContextStore } from '../db/translation-context';
import { isTargetLanguage, type TargetLanguage } from '../domain/language';
import { errorBody } from '../http/json';
import { createTelemetry, withProviderTelemetry } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { ContextualWorkersAITranslationProvider } from '../services/translation/contextual';
import { GoogleCloudTranslationProvider } from '../services/translation/google';
import { isTranslationContextActive } from '../services/translation/context';
import { TranslationRouter, type TranslationMode } from '../services/translation/router';
import { TranslationProviderError } from '../services/translation/types';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';

const MODES = new Set<TranslationMode>(['workers-ai', 'google', 'compare', 'contextual']);

type VariantStore = {
  list(projectId: string, userId: string, target: TargetLanguage): Promise<SegmentTranslation[]>;
  get(projectId: string, segmentId: string, userId: string, target: TargetLanguage): Promise<SegmentTranslation | null>;
  updateText(
    projectId: string,
    segmentId: string,
    userId: string,
    target: TargetLanguage,
    expectedVersion: number,
    text: string,
  ): Promise<SegmentTranslation>;
  setTranslationResult(
    projectId: string,
    segmentId: string,
    userId: string,
    target: TargetLanguage,
    text: string,
    engine: 'workers-ai' | 'google',
    contextRevision: number | null,
  ): Promise<SegmentTranslation>;
};

export type TranslationVariantRouteDeps = {
  makeProjects?: (env: Env) => Pick<ProjectStore, 'getByIdForUser'>;
  makeSegments?: (env: Env) => Pick<SegmentStore, 'list' | 'get'>;
  makeVariants?: (env: Env) => VariantStore;
  makeLanguages?: (env: Env) => ProjectLanguageStore;
  makeContext?: (env: Env) => TranslationContextStore;
  makeRouter?: (env: Env) => TranslationRouter;
  makeJobs?: (env: Env) => Pick<JobStore, 'create' | 'fail'>;
};

function providerErrorStatus(code: string): 400 | 409 | 502 | 503 {
  if (code === 'TRANSLATION_CONTEXT_TOO_LARGE' || code === 'TRANSLATION_TARGET_UNSUPPORTED') return 400;
  if (code === 'TRANSLATION_CONTEXT_UNSUPPORTED') return 409;
  if (code === 'CONTEXT_TRANSLATION_UNAVAILABLE') return 503;
  return 502;
}

function targetFrom(value: string): TargetLanguage | null {
  return isTargetLanguage(value) ? value : null;
}

async function enabledTarget(
  languages: ProjectLanguageStore,
  projectId: string,
  userId: string,
  target: TargetLanguage,
): Promise<'enabled' | 'project-not-found' | 'language-not-found'> {
  const config = await languages.getConfig(projectId, userId);
  if (!config) return 'project-not-found';
  return config.languages.some((entry) => entry.targetLanguage === target)
    ? 'enabled'
    : 'language-not-found';
}

function variantPersistenceResponse(c: any, error: SegmentTranslationPersistenceError) {
  if (error.code === 'PROJECT_NOT_FOUND') {
    return c.json(errorBody(error.code, error.message), 404);
  }
  if (error.code === 'TRANSLATION_VARIANT_NOT_FOUND') {
    return c.json(errorBody(error.code, error.message), 404);
  }
  return c.json({ ...errorBody(error.code, error.message), canonical: error.canonical }, 409);
}

export function createTranslationVariantRoutes(deps: TranslationVariantRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeSegments = deps.makeSegments ?? ((env: Env) => new SegmentRepository(env.DB));
  const makeVariants = deps.makeVariants ?? ((env: Env) => new SegmentTranslationRepository(env.DB));
  const makeLanguages = deps.makeLanguages ?? ((env: Env) => new ProjectLanguageRepository(env.DB));
  const makeContext = deps.makeContext ?? ((env: Env) => new TranslationContextRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeRouter = deps.makeRouter ?? ((env: Env) => new TranslationRouter(
    new WorkersAITranslationProvider(env.AI),
    new GoogleCloudTranslationProvider(env.GOOGLE_CLOUD_TRANSLATE_API_KEY ?? ''),
    new ContextualWorkersAITranslationProvider(env.AI, env.CONTEXT_TRANSLATION_MODEL ?? ''),
  ));

  routes.get('/:id/translations/:language', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const target = targetFrom(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    const admitted = await enabledTarget(makeLanguages(c.env), projectId, userId, target);
    if (admitted !== 'enabled') {
      return c.json(errorBody(
        admitted === 'project-not-found' ? 'PROJECT_NOT_FOUND' : 'PROJECT_LANGUAGE_NOT_FOUND',
        admitted === 'project-not-found' ? 'Project not found.' : 'Target language is not enabled for this project.',
      ), 404);
    }

    const [canonical, targetRows] = await Promise.all([
      makeSegments(c.env).list(projectId, userId),
      makeVariants(c.env).list(projectId, userId, target),
    ]);
    const bySegment = new Map(targetRows.map((row) => [row.segmentId, row]));
    return c.json({
      targetLanguage: target,
      segments: canonical.map((segment) => ({
        segmentId: segment.id,
        sourceText: segment.sourceText,
        startMs: segment.startMs,
        endMs: segment.endMs,
        speakerId: segment.speakerId,
        translation: bySegment.get(segment.id) ?? null,
      })),
    });
  });

  routes.patch('/:id/translations/:language/:segmentId', async (c) => {
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const target = targetFrom(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    const admitted = await enabledTarget(makeLanguages(c.env), projectId, userId, target);
    if (admitted !== 'enabled') {
      return c.json(errorBody('PROJECT_LANGUAGE_NOT_FOUND', 'Target language is not enabled for this project.'), 404);
    }

    let input: { expectedVersion?: number; translatedText?: unknown };
    try {
      input = await c.req.json();
    } catch {
      return c.json(errorBody('TRANSLATION_VARIANT_INVALID', 'Request body must contain valid JSON.'), 400);
    }
    if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
      return c.json(errorBody('TRANSLATION_VARIANT_INVALID', 'expectedVersion must be a positive integer.'), 400);
    }
    if (typeof input.translatedText !== 'string' || input.translatedText.trim().length === 0) {
      return c.json(errorBody('TRANSLATION_VARIANT_INVALID', 'translatedText must be non-empty text.'), 400);
    }

    try {
      const updated = await makeVariants(c.env).updateText(
        projectId,
        segmentId,
        userId,
        target,
        input.expectedVersion as number,
        input.translatedText.trim(),
      );
      return c.json(updated);
    } catch (error) {
      if (error instanceof SegmentTranslationPersistenceError) return variantPersistenceResponse(c, error);
      return c.json(errorBody('TRANSLATION_VARIANT_UPDATE_FAILED', 'Unable to update translation variant.'), 500);
    }
  });

  routes.post('/:id/translations/:language/:segmentId/retranslate', async (c) => {
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const target = targetFrom(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    const admitted = await enabledTarget(makeLanguages(c.env), projectId, userId, target);
    if (admitted !== 'enabled') {
      return c.json(errorBody('PROJECT_LANGUAGE_NOT_FOUND', 'Target language is not enabled for this project.'), 404);
    }
    const segment = await makeSegments(c.env).get(projectId, segmentId, userId);
    if (!segment) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);

    let input: { mode?: TranslationMode } = {};
    try {
      input = await c.req.json();
    } catch {
      return c.json(errorBody('TRANSLATION_REQUEST_INVALID', 'Request body must contain valid JSON.'), 400);
    }
    if (input.mode !== undefined && !MODES.has(input.mode)) {
      return c.json(errorBody('TRANSLATION_MODE_INVALID', 'Unknown translation mode.'), 400);
    }

    const rateLimited = await enforceRateLimit(c, 'translate', userId, projectId);
    if (rateLimited) return rateLimited;

    try {
      const context = await makeContext(c.env).getContext(projectId, userId, target);
      if (!context) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      const provider = input.mode === 'compare'
        ? 'translation-router'
        : input.mode === 'contextual'
          ? 'workers-ai-contextual'
          : input.mode ?? (isTranslationContextActive(context) ? 'workers-ai-contextual' : 'workers-ai');
      const result = await withProviderTelemetry(createTelemetry(c.env), {
        requestId: c.get('requestId'),
        actorId: userId,
        projectId,
        operation: 'translate',
        provider,
        errorCode: 'TRANSLATION_PROVIDER_FAILED',
      }, () => makeRouter(c.env).translate(
        input.mode,
        [{ id: segment.id, text: segment.sourceText }],
        project.sourceLanguage,
        target,
        context,
      ));
      if (result.mode === 'compare') return c.json(result);
      const translated = result.primary[0];
      if (!translated) return c.json(errorBody('TRANSLATION_EMPTY', 'Translation provider returned no result.'), 502);
      const engine = translated.provider === 'google' ? 'google' : 'workers-ai';
      const persisted = await makeVariants(c.env).setTranslationResult(
        projectId,
        segment.id,
        userId,
        target,
        translated.text,
        engine,
        result.contextRevision,
      );
      return c.json({ mode: result.mode, result: translated, translation: persisted });
    } catch (error) {
      if (error instanceof SegmentTranslationPersistenceError) return variantPersistenceResponse(c, error);
      if (error instanceof TranslationProviderError) {
        return c.json(errorBody(error.code, error.message), providerErrorStatus(error.code));
      }
      return c.json(errorBody('TRANSLATION_FAILED', 'Unable to translate segment.'), 500);
    }
  });

  routes.post('/:id/translations/:language/process', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const target = targetFrom(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    const languages = makeLanguages(c.env);
    const admitted = await enabledTarget(languages, projectId, userId, target);
    if (admitted !== 'enabled') {
      return c.json(errorBody('PROJECT_LANGUAGE_NOT_FOUND', 'Target language is not enabled for this project.'), 404);
    }

    const rateLimited = await enforceRateLimit(c, 'translate', userId, projectId);
    if (rateLimited) return rateLimited;

    const jobs = makeJobs(c.env);
    const job = await jobs.create(projectId, `translation:${target}`);
    try {
      const instance = await c.env.LANGUAGE_TRANSLATION_WORKFLOW.create({
        params: {
          projectId,
          userId,
          jobId: job.id,
          targetLanguage: target,
          requestId: c.get('requestId'),
        },
      });
      await languages.setStatus(projectId, userId, target, 'translating');
      return c.json({
        jobId: job.id,
        workflowId: instance.id,
        status: 'queued' as const,
        targetLanguage: target,
      }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start language translation Workflow.';
      await jobs.fail(job.id, 'WORKFLOW_START_FAILED', message);
      try {
        await languages.setStatus(projectId, userId, target, 'failed');
      } catch {
        // Preserve the Workflow-start error when status persistence also fails.
      }
      return c.json(errorBody('WORKFLOW_START_FAILED', message), 503);
    }
  });

  return routes;
}
