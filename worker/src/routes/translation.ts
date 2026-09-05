import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { SegmentRepository } from '../db/segments';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';
import { WorkersAITranslationProvider } from '../services/translation/workers-ai';
import { GoogleCloudTranslationProvider } from '../services/translation/google';
import { TranslationRouter, type TranslationMode } from '../services/translation/router';
import { TranslationProviderError } from '../services/translation/types';

const MODES = new Set<TranslationMode>(['workers-ai', 'google', 'compare']);

export function createTranslationRoutes() {
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

    const input = await c.req.json() as { mode?: TranslationMode };
    const mode = input.mode ?? 'workers-ai';
    if (!MODES.has(mode)) return c.json(errorBody('TRANSLATION_MODE_INVALID', 'Unknown translation mode.'), 400);

    try {
      const router = new TranslationRouter(
        new WorkersAITranslationProvider(c.env.AI),
        new GoogleCloudTranslationProvider(c.env.GOOGLE_CLOUD_TRANSLATE_API_KEY ?? ''),
      );
      const result = await router.translate(mode, [{ id: segment.id, text: segment.sourceText }], project.sourceLanguage, 'vi');
      if (result.mode === 'compare') return c.json(result);
      const translated = result.primary[0];
      if (!translated) return c.json(errorBody('TRANSLATION_EMPTY', 'Translation provider returned no result.'), 502);
      const engine = translated.provider === 'google' ? 'google' : 'workers-ai';
      const updated = await segments.setTranslationResult(projectId, segmentId, userId, translated.text, engine);
      return c.json({ mode, result: translated, segment: updated });
    } catch (error) {
      if (error instanceof TranslationProviderError) return c.json(errorBody(error.code, error.message), 502);
      return c.json(errorBody('TRANSLATION_FAILED', 'Unable to translate segment.'), 500);
    }
  });

  return routes;
}
