import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { SegmentPersistenceError, SegmentRepository, type SegmentStore } from '../db/segments';
import { TranslationContextRepository, type TranslationContextStore } from '../db/translation-context';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { errorBody } from '../http/json';
import { createTelemetry, withProviderTelemetry } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';
import { GoogleCloudTranslationProvider } from '../services/translation/google';
import { ContextualWorkersAITranslationProvider } from '../services/translation/contextual';
import { isTranslationContextActive } from '../services/translation/context';
import { TranslationRouter, type TranslationMode } from '../services/translation/router';
import { TranslationProviderError } from '../services/translation/types';

const MODES = new Set<TranslationMode>(['workers-ai', 'google', 'compare', 'contextual']);

export type TranslationRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeSegments?: (env: Env) => SegmentStore;
  makeContext?: (env: Env) => TranslationContextStore;
  makeRouter?: (env: Env) => TranslationRouter;
};

function providerErrorStatus(code: string): 400 | 409 | 502 | 503 {
  if (code === 'TRANSLATION_CONTEXT_TOO_LARGE') return 400;
  if (code === 'TRANSLATION_CONTEXT_UNSUPPORTED') return 409;
  if (code === 'CONTEXT_TRANSLATION_UNAVAILABLE') return 503;
  return 502;
}

export function createTranslationRoutes(deps: TranslationRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeSegments = deps.makeSegments ?? ((env: Env) => new SegmentRepository(env.DB));
  const makeContext = deps.makeContext ?? ((env: Env) => new TranslationContextRepository(env.DB));
  const makeRouter = deps.makeRouter ?? ((env: Env) => new TranslationRouter(
    new WorkersAITranslationProvider(env.AI),
    new GoogleCloudTranslationProvider(env.GOOGLE_CLOUD_TRANSLATE_API_KEY ?? ''),
    new ContextualWorkersAITranslationProvider(env.AI, env.CONTEXT_TRANSLATION_MODEL ?? ''),
  ));

  routes.post('/:id/segments/:segmentId/retranslate', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const projects = makeProjects(c.env);
    const segments = makeSegments(c.env);
    const contexts = makeContext(c.env);

    const project = await projects.getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    const segment = await segments.get(projectId, segmentId, userId);
    if (!segment) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);

    let input: { expectedVersion?: number; mode?: TranslationMode };
    try {
      input = await c.req.json() as { expectedVersion?: number; mode?: TranslationMode };
    } catch {
      return c.json(errorBody('TRANSLATION_REQUEST_INVALID', 'Request body must contain valid JSON.'), 400);
    }

    const expectedVersion = input.expectedVersion;
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
      return c.json(errorBody('INVALID_SEGMENT_VERSION', 'expectedVersion must be a positive integer.'), 400);
    }
    if (input.mode !== undefined && !MODES.has(input.mode)) {
      return c.json(errorBody('TRANSLATION_MODE_INVALID', 'Unknown translation mode.'), 400);
    }
    if (segment.version !== expectedVersion) {
      return c.json({
        ...errorBody('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.'),
        segment,
      }, 409);
    }

    const rateLimited = await enforceRateLimit(c, 'translate', userId, projectId);
    if (rateLimited) return rateLimited;

    try {
      const context = await contexts.getContext(projectId, userId);
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
        'vi',
        context,
      ));
      if (result.mode === 'compare') return c.json(result);

      const translated = result.primary[0];
      if (!translated) return c.json(errorBody('TRANSLATION_EMPTY', 'Translation provider returned no result.'), 502);
      const engine = translated.provider === 'google' ? 'google' : 'workers-ai';
      const updated = await segments.setTranslationResult(
        projectId,
        segmentId,
        userId,
        expectedVersion as number,
        translated.text,
        engine,
        result.contextRevision,
      );
      if (!updated) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
      return c.json({ mode: result.mode, result: translated, segment: updated });
    } catch (error) {
      if (error instanceof SegmentPersistenceError && error.code === 'SEGMENT_VERSION_CONFLICT') {
        const canonical = await segments.get(projectId, segmentId, userId);
        if (!canonical) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
        return c.json({ ...errorBody(error.code, error.message), segment: canonical }, 409);
      }
      if (error instanceof TranslationProviderError) {
        return c.json(errorBody(error.code, error.message), providerErrorStatus(error.code));
      }
      return c.json(errorBody('TRANSLATION_FAILED', 'Unable to translate segment.'), 500);
    }
  });

  return routes;
}
