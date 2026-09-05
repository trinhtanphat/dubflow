import { Hono } from 'hono';
import type { Env } from '../env';
import {
  SegmentInputError,
  normalizeSegmentPatch,
  type SegmentRestoreInput,
} from '../domain/segment';
import {
  SegmentPersistenceError,
  SegmentRepository,
  type SegmentStore,
} from '../db/segments';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';

type SegmentStoreFactory = (env: Env) => SegmentStore;

function persistenceErrorResponse(c: any, error: SegmentPersistenceError) {
  if (error.code === 'SEGMENT_NOT_FOUND' || error.code === 'PROJECT_NOT_FOUND') {
    return c.json(errorBody(error.code, error.message), 404);
  }
  if (error.code === 'SEGMENT_OVERLAP' || error.code === 'SPLIT_LINEAGE_MISMATCH') {
    return c.json(errorBody(error.code, error.message), 409);
  }
  if (error.code === 'D1_BATCH_UNAVAILABLE') {
    return c.json(errorBody(error.code, error.message), 503);
  }
  return c.json(errorBody(error.code, error.message), 400);
}

function readSplitPoint(input: unknown): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SegmentPersistenceError('INVALID_SPLIT_POINT', 'Split payload must contain an integer playheadMs.');
  }
  const playheadMs = (input as Record<string, unknown>).playheadMs;
  if (!Number.isInteger(playheadMs)) {
    throw new SegmentPersistenceError('INVALID_SPLIT_POINT', 'playheadMs must be an integer.');
  }
  return playheadMs as number;
}

function readRestorePayload(input: unknown): { childSegmentId: string; original: SegmentRestoreInput } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SegmentInputError('Restore payload must be an object.');
  }
  const record = input as Record<string, unknown>;
  if (typeof record.childSegmentId !== 'string' || record.childSegmentId.trim().length === 0) {
    throw new SegmentInputError('childSegmentId must be a non-empty string.');
  }
  if (!record.original || typeof record.original !== 'object' || Array.isArray(record.original)) {
    throw new SegmentInputError('original must be a segment snapshot object.');
  }
  return {
    childSegmentId: record.childSegmentId.trim(),
    original: record.original as SegmentRestoreInput,
  };
}

export function createSegmentRoutes(
  makeStore: SegmentStoreFactory = (env) => new SegmentRepository(env.DB),
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/:id/segments', async (c) => {
    const repo = makeStore(c.env);
    return c.json(await repo.list(c.req.param('id'), getCurrentUserId()));
  });

  routes.patch('/:id/segments/:segmentId', async (c) => {
    const repo = makeStore(c.env);
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const userId = getCurrentUserId();
    try {
      const current = await repo.get(projectId, segmentId, userId);
      if (!current) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
      const patch = normalizeSegmentPatch(await c.req.json(), current);
      const updated = await repo.updateSegment(projectId, segmentId, userId, patch);
      if (!updated) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
      return c.json(updated);
    } catch (error) {
      if (error instanceof SegmentInputError) return c.json(errorBody(error.code, error.message), 400);
      if (error instanceof SegmentPersistenceError) return persistenceErrorResponse(c, error);
      return c.json(errorBody('SEGMENT_UPDATE_FAILED', 'Unable to update segment.'), 500);
    }
  });

  routes.post('/:id/segments/:segmentId/split', async (c) => {
    const repo = makeStore(c.env);
    try {
      const result = await repo.splitSegment(
        c.req.param('id'),
        c.req.param('segmentId'),
        getCurrentUserId(),
        readSplitPoint(await c.req.json()),
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof SegmentInputError) return c.json(errorBody(error.code, error.message), 400);
      if (error instanceof SegmentPersistenceError) return persistenceErrorResponse(c, error);
      return c.json(errorBody('SEGMENT_SPLIT_FAILED', 'Unable to split segment.'), 500);
    }
  });

  routes.post('/:id/segments/:segmentId/restore-split', async (c) => {
    const repo = makeStore(c.env);
    try {
      const payload = readRestorePayload(await c.req.json());
      const restored = await repo.restoreSplit(
        c.req.param('id'),
        c.req.param('segmentId'),
        payload.childSegmentId,
        getCurrentUserId(),
        payload.original,
      );
      return c.json(restored);
    } catch (error) {
      if (error instanceof SegmentInputError) return c.json(errorBody(error.code, error.message), 400);
      if (error instanceof SegmentPersistenceError) return persistenceErrorResponse(c, error);
      return c.json(errorBody('SEGMENT_RESTORE_FAILED', 'Unable to restore segment split.'), 500);
    }
  });

  return routes;
}
