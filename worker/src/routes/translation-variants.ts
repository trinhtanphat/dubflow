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
import { TranslationRouter, type TranslationMode } from '../services/translation/router';
import { TranslationProviderError } from '../services/translation/types';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';

const MODES = new Set<TranslationMode>(['workers-ai', 'google', 'compare', 'contextual']);

type VariantStore = Pick<
  SegmentTranslationRepository,
  'list' | 'get' | 'updateText' | 'setTranslationResult'
>;
type LanguageProcessStore = Pick<ProjectLanguageStore, 'getConfig' | 'setStatus'>;
type JobLaunchStore = Pick<JobStore, 'create' | 'fail'>;

type RouterLike = Pick<TranslationRouter, 'translate'>;

export type TranslationVariantRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeSegments?: (env: Env) => SegmentStore;
  makeVariants?: (env: Env) => VariantStore;
  makeLanguages?: (env: Env) => LanguageProcessStore;
  makeJobs?: (env: Env) => JobLaunchStore;
  makeContext?: (env: Env) => TranslationContextStore;
  makeRouter?: (env: Env) => RouterLike;
};

function providerErrorStatus(code: string): 400 | 409 | 502 | 503 {
  if (code === 'TRANSLATION_TARGET_UNSUPPORTED' || code === 'TRANSLATION_CONTEXT_TOO_LARGE') return 400;
  if (code === 'TRANSLATION_CONTEXT_UNSUPPORTED') return 409;
  if (code === 'CONTEXT_TRANSLATION_UNAVAILABLE') return 503;
  return 502;
}

function variantError(error: SegmentTranslationPersistenceError) {
  if (error.code === 'TRANSLATION_VARIANT_CONFLICT') {
    return {
      status: 409 as const,
      body: { ...errorBody(error.code, error.message), canonical: error.canonical ?? null },
    };
  }
  return { status: 404 as const, body: errorBody(error.code, error.message) };
}

function targetFromPath(value: string): TargetLanguage | null {
  return isTargetLanguage(value) ? value : null;
}

function languageEnabled(
  config: Awaited<ReturnType<LanguageProcessStore['getConfig']>>,
  target: TargetLanguage,
): boolean {
  return Boolean(config?.languages.some((entry) => entry.targetLanguage === target));
}

async function optionalJson(c: any): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export function createTranslationVariantRoutes(deps: TranslationVariantRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeSegments = deps.makeSegments ?? ((env: Env) => new SegmentRepository(env.DB));
  const makeVariants = deps.makeVariants ?? ((env: Env) => new SegmentTranslationRepository(env.DB));
  const makeLanguages = deps.makeLanguages ?? ((env: Env) => new ProjectLanguageRepository(env.DB));
  const makeJobs = deps.makeJobs ?? ((env: Env) => new JobRepository(env.DB));
  const makeContext = deps.makeContext ?? ((env: Env) => new TranslationContextRepository(env.DB));
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

    const target = targetFromPath(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Unsupported target language.'), 400);

    const [segments, translations] = await Promise.all([
      makeSegments(c.env).list(projectId, userId),
      makeVariants(c.env).list(projectId, userId, target),
    ]);
    const bySegment = new Map(translations.map((translation) => [translation.segmentId, translation]));
    return c.json({
      targetLanguage: target,
      segments: segments.map((segment) => ({
        segmentId: segment.id,
        speakerId: segment.speakerId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        sourceText: segment.sourceText,
        sourceVersion: segment.version,
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

    const target = targetFromPath(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Unsupported target language.'), 400);
    const source = await makeSegments(c.env).get(projectId, segmentId, userId);
    if (!source) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);

    let input: { expectedVersion?: unknown; translatedText?: unknown };
    try {
      input = await c.req.json() as { expectedVersion?: unknown; translatedText?: unknown };
    } catch {
      return c.json(errorBody('TRANSLATION_VARIANT_INVALID', 'Request body must contain valid JSON.'), 400);
    }
    if (!Number.isInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
      return c.json(errorBody('TRANSLATION_VARIANT_INVALID', 'expectedVersion must be a positive integer.'), 400);
    }
    if (typeof input.translatedText !== 'string') {
      return c.json(errorBody('TRANSLATION_VARIANT_INVALID', 'translatedText must be a string.'), 400);
    }

    try {
      const translation = await makeVariants(c.env).updateText(
        projectId,
        segmentId,
        userId,
        target,
        Number(input.expectedVersion),
        input.translatedText,
      );
      return c.json({ translation });
    } catch (error) {
      if (error instanceof SegmentTranslationPersistenceError) {
        const mapped = variantError(error);
        return c.json(mapped.body, mapped.status);
      }
      return c.json(errorBody('TRANSLATION_VARIANT_FAILED', 'Unable to update translation variant.'), 500);
    }
  });

  routes.post('/:id/translations/:language/:segmentId/retranslate', async (c) => {
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const userId = getCurrentUserId();
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const target = targetFromPath(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Unsupported target language.'), 400);
    const source = await makeSegments(c.env).get(projectId, segmentId, userId);
    if (!source) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);

    let input: Record<string, unknown>;
    try {
      input = await optionalJson(c);
    } catch {
      return c.json(errorBody('TRANSLATION_REQUEST_INVALID', 'Request body must contain valid JSON.'), 400);
    }
    const mode = input.mode as TranslationMode | undefined;
    if (mode !== undefined && !MODES.has(mode)) {
      return c.json(errorBody('TRANSLATION_MODE_INVALID', 'Unknown translation mode.'), 400);
    }

    const rateLimited = await enforceRateLimit(c, 'translate', userId, projectId);
    if (rateLimited) return rateLimited;

    try {
      const context = await makeContext(c.env).getContext(projectId, userId, target);
      if (!context) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      const provider = mode === 'compare'
        ? 'translation-router'
        : mode === 'contextual'
          ? 'workers-ai-contextual'
          : mode ?? 'workers-ai';
      const routed = await withProviderTelemetry(createTelemetry(c.env), {
        requestId: c.get('requestId'),
        actorId: userId,
        projectId,
        operation: 'translate',
        provider,
        errorCode: 'TRANSLATION_PROVIDER_FAILED',
      }, () => makeRouter(c.env).translate(
        mode,
        [{ id: source.id, text: source.sourceText }],
        project.sourceLanguage,
        target,
        context,
      ));

      if (routed.mode === 'compare') return c.json(routed);
      const translated = routed.primary[0];
      if (!translated) return c.json(errorBody('TRANSLATION_EMPTY', 'Translation provider returned no result.'), 502);
      const engine = translated.provider === 'google' ? 'google' : 'workers-ai';
      const translation = await makeVariants(c.env).setTranslationResult(
        projectId,
        segmentId,
        userId,
        target,
        translated.text,
        engine,
        routed.contextRevision,
      );
      return c.json({ mode: routed.mode, result: translated, translation });
    } catch (error) {
      if (error instanceof SegmentTranslationPersistenceError) {
        const mapped = variantError(error);
        return c.json(mapped.body, mapped.status);
      }
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

    const target = targetFromPath(c.req.param('language'));
    if (!target) return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Unsupported target language.'), 400);

    const languages = makeLanguages(c.env);
    const config = await languages.getConfig(projectId, userId);
    if (!config) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!languageEnabled(config, target)) {
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
        // Preserve the original Workflow-start failure response.
      }
      return c.json(errorBody('WORKFLOW_START_FAILED', message), 503);
    }
  });

  return routes;
}
