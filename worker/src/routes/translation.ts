import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { SegmentPersistenceError, SegmentRepository } from '../db/segments';
import { UsageRepository, type UsageStore } from '../db/usage';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';
import { GoogleCloudTranslationProvider } from '../services/translation/google';
import { TranslationRouter, type TranslationMode } from '../services/translation/router';
import { TranslationProviderError } from '../services/translation/types';

const MODES = new Set<TranslationMode>(['workers-ai', 'google', 'compare']);

type UsageStoreFactory = (env: Env) => Pick<UsageStore, 'record'>;

async function recordTranslationUsage(
  usage: Pick<UsageStore, 'record'>,
  input: {
    userId: string;
    projectId: string;
    provider: 'workers-ai' | 'google';
    units: number;
    requestId: string;
  },
) {
  await usage.record({
    userId: input.userId,
    projectId: input.projectId,
    jobId: null,
    kind: 'translation_characters',
    units: input.units,
    provider: input.provider,
    idempotencyKey: `request:${input.requestId}:translation:${input.provider}`,
  });
}

export function createTranslationRoutes(
  makeUsage: UsageStoreFactory = (env) => new UsageRepository(env.DB),
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/:id/segments/:segmentId/retranslate', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const projects = new ProjectRepository(c.env.DB);
    const segments = new SegmentRepository(c.env.DB);
    const project = await projects.getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    const segment = await segments.get(projectId, segmentId, userId);
    if (!segment) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);

    let input: { expectedVersion?: number; mode?: TranslationMode };
    try {
      input = await c.req.json();
    } catch {
      return c.json(errorBody('INVALID_JSON', 'Translation request body must be valid JSON.'), 400);
    }

    const expectedVersion = input.expectedVersion;
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
      return c.json(errorBody('INVALID_SEGMENT_VERSION', 'expectedVersion must be a positive integer.'), 400);
    }
    const mode = input.mode ?? 'workers-ai';
    if (!MODES.has(mode)) return c.json(errorBody('TRANSLATION_MODE_INVALID', 'Unknown translation mode.'), 400);
    if (segment.version !== expectedVersion) {
      return c.json({
        ...errorBody('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.'),
        segment,
      }, 409);
    }

    const sourceText = segment.sourceText.trim();
    if (!sourceText) {
      return c.json(errorBody('TRANSLATION_TEXT_REQUIRED', 'Segment source text is required.'), 400);
    }

    try {
      const router = new TranslationRouter(
        new WorkersAITranslationProvider(c.env.AI),
        new GoogleCloudTranslationProvider(c.env.GOOGLE_CLOUD_TRANSLATE_API_KEY ?? ''),
      );
      const result = await router.translate(mode, [{ id: segment.id, text: sourceText }], project.sourceLanguage, 'vi');
      const requestId = crypto.randomUUID();
      const usage = makeUsage(c.env);

      if (result.mode === 'compare') {
        try {
          await recordTranslationUsage(usage, {
            userId,
            projectId,
            provider: 'workers-ai',
            units: sourceText.length,
            requestId,
          });
          await recordTranslationUsage(usage, {
            userId,
            projectId,
            provider: 'google',
            units: sourceText.length,
            requestId,
          });
        } catch {
          return c.json(errorBody('USAGE_RECORD_FAILED', 'Unable to record translation usage.'), 500);
        }
        return c.json(result);
      }

      const translated = result.primary[0];
      if (!translated) return c.json(errorBody('TRANSLATION_EMPTY', 'Translation provider returned no result.'), 502);
      const engine = translated.provider === 'google' ? 'google' : 'workers-ai';
      try {
        await recordTranslationUsage(usage, {
          userId,
          projectId,
          provider: engine,
          units: sourceText.length,
          requestId,
        });
      } catch {
        return c.json(errorBody('USAGE_RECORD_FAILED', 'Unable to record translation usage.'), 500);
      }

      const updated = await segments.setTranslationResult(
        projectId,
        segmentId,
        userId,
        expectedVersion as number,
        translated.text,
        engine,
      );
      if (!updated) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
      return c.json({ mode, result: translated, segment: updated });
    } catch (error) {
      if (error instanceof SegmentPersistenceError && error.code === 'SEGMENT_VERSION_CONFLICT') {
        const canonical = await segments.get(projectId, segmentId, userId);
        if (!canonical) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
        return c.json({ ...errorBody(error.code, error.message), segment: canonical }, 409);
      }
      if (error instanceof TranslationProviderError) return c.json(errorBody(error.code, error.message), 502);
      return c.json(errorBody('TRANSLATION_FAILED', 'Unable to translate segment.'), 500);
    }
  });

  return routes;
}
