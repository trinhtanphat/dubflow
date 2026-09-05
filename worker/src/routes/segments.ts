import { Hono } from 'hono';
import type { Env } from '../env';
import { SegmentInputError, normalizeSegmentPatch } from '../domain/segment';
import { SegmentRepository } from '../db/segments';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';

export function createSegmentRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get('/:id/segments', async (c) => {
    const repo = new SegmentRepository(c.env.DB);
    return c.json(await repo.list(c.req.param('id'), getCurrentUserId()));
  });
  routes.patch('/:id/segments/:segmentId', async (c) => {
    const repo = new SegmentRepository(c.env.DB);
    const current = await repo.get(c.req.param('id'), c.req.param('segmentId'), getCurrentUserId());
    if (!current) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
    try {
      const patch = normalizeSegmentPatch(await c.req.json(), current);
      return c.json(await repo.updateText(c.req.param('id'), c.req.param('segmentId'), getCurrentUserId(), patch));
    } catch (error) {
      if (error instanceof SegmentInputError) return c.json(errorBody(error.code, error.message), 400);
      return c.json(errorBody('SEGMENT_UPDATE_FAILED', 'Unable to update segment.'), 500);
    }
  });
  return routes;
}
