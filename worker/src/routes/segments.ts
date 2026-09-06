import { Hono } from 'hono';
import type { Env } from '../env';
import {
  SegmentInputError,
  normalizeSegmentPatch,
  type SegmentRestoreInput,
} from '../domain/segment';
import { MultilangRepository } from '../db/multilang';
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
  if (error.code === 'SEGMENT_OVERLAP'
    || error.code === 'SPLIT_LINEAGE_MISMATCH'
    || error.code === 'SEGMENT_VERSION_CONFLICT'
    || error.code === 'PROJECT_BUSY') {
    return c.json(errorBody(error.code, error.message), 409);
  }
  if (error.code === 'D1_BATCH_UNAVAILABLE') {
    return c.json(errorBody(error.code, error.message), 503);
  }
  return c.json(errorBody(error.code, error.message), 400);
}

function readPositiveVersion(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new SegmentInputError(`${field} must be a positive integer.`);
  }
  return value as number;
}

function readSegmentPatchRequest(input: unknown): { expectedVersion: number; patch: unknown } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SegmentInputError('Segment patch request must be an object.');
  }
  const record = input as Record<string, unknown>;
  const expectedVersion = readPositiveVersion(record, 'expectedVersion');
  if (!record.patch || typeof record.patch !== 'object' || Array.isArray(record.patch)) {
    throw new SegmentInputError('patch must be an object.');
  }
  return { expectedVersion, patch: record.patch };
}

function readSplitRequest(input: unknown): { expectedVersion: number; playheadMs: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SegmentPersistenceError('INVALID_SPLIT_POINT', 'Split payload must contain expectedVersion and playheadMs.');
  }
  const record = input as Record<string, unknown>;
  const expectedVersion = readPositiveVersion(record, 'expectedVersion');
  if (!Number.isInteger(record.playheadMs)) {
    throw new SegmentPersistenceError('INVALID_SPLIT_POINT', 'playheadMs must be an integer.');
  }
  return { expectedVersion, playheadMs: record.playheadMs as number };
}

function readRestorePayload(input: unknown): {
  expectedVersion: number;
  childSegmentId: string;
  expectedChildVersion: number;
  original: SegmentRestoreInput;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SegmentInputError('Restore payload must be an object.');
  }
  const record = input as Record<string, unknown>;
  const expectedVersion = readPositiveVersion(record, 'expectedVersion');
  const expectedChildVersion = readPositiveVersion(record, 'expectedChildVersion');
  if (typeof record.childSegmentId !== 'string' || record.childSegmentId.trim().length === 0) {
    throw new SegmentInputError('childSegmentId must be a non-empty string.');
  }
  if (!record.original || typeof record.original !== 'object' || Array.isArray(record.original)) {
    throw new SegmentInputError('original must be a segment snapshot object.');
  }
  return {
    expectedVersion,
    childSegmentId: record.childSegmentId.trim(),
    expectedChildVersion,
    original: record.original as SegmentRestoreInput,
  };
}

async function versionConflictResponse(
  c: any,
  repo: SegmentStore,
  projectId: string,
  segmentId: string,
  userId: string,
  error: SegmentPersistenceError,
) {
  const canonical = await repo.get(projectId, segmentId, userId);
  if (!canonical) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
  return c.json({ ...errorBody(error.code, error.message), segment: canonical }, 409);
}

export function createSegmentRoutes(
  makeStore: SegmentStoreFactory = (env) => new SegmentRepository(env.DB, new MultilangRepository(env.DB)),
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
      const request = readSegmentPatchRequest(await c.req.json());
      const current = await repo.get(projectId, segmentId, userId);
      if (!current) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
      const patch = normalizeSegmentPatch(request.patch, current);
      const updated = await repo.updateSegment(projectId, segmentId, userId, request.expectedVersion, patch);
      if (!updated) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);
      return c.json(updated);
    } catch (error) {
      if (error instanceof SegmentInputError) return c.json(errorBody(error.code, error.message), 400);
      if (error instanceof SegmentPersistenceError && error.code === 'SEGMENT_VERSION_CONFLICT') {
        return versionConflictResponse(c, repo, projectId, segmentId, userId, error);
      }
      if (error instanceof SegmentPersistenceError) return persistenceErrorResponse(c, error);
      return c.json(errorBody('SEGMENT_UPDATE_FAILED', 'Unable to update segment.'), 500);
    }
  });

  routes.post('/:id/segments/:segmentId/split', async (c) => {
    const repo = makeStore(c.env);
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const userId = getCurrentUserId();
    try {
      const request = readSplitRequest(await c.req.json());
      const result = await repo.splitSegment(
        projectId,
        segmentId,
        userId,
        request.expectedVersion,
        request.playheadMs,
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof SegmentInputError) return c.json(errorBody(error.code, error.message), 400);
      if (error instanceof SegmentPersistenceError && error.code === 'SEGMENT_VERSION_CONFLICT') {
        return versionConflictResponse(c, repo, projectId, segmentId, userId, error);
      }
      if (error instanceof SegmentPersistenceError) return persistenceErrorResponse(c, error);
      return c.json(errorBody('SEGMENT_SPLIT_FAILED', 'Unable to split segment.'), 500);
    }
  });

  routes.post('/:id/segments/:segmentId/restore-split', async (c) => {
    const repo = makeStore(c.env);
    const projectId = c.req.param('id');
    const segmentId = c.req.param('segmentId');
    const userId = getCurrentUserId();
    try {
      const payload = readRestorePayload(await c.req.json());
      const restored = await repo.restoreSplit(
        projectId,
        segmentId,
        userId,
        payload.expectedVersion,
        payload.childSegmentId,
        payload.expectedChildVersion,
        payload.original,
      );
      return c.json(restored);
    } catch (error) {
      if (error instanceof SegmentInputError) return c.json(errorBody(error.code, error.message), 400);
      if (error instanceof SegmentPersistenceError && error.code === 'SEGMENT_VERSION_CONFLICT') {
        return versionConflictResponse(c, repo, projectId, segmentId, userId, error);
      }
      if (error instanceof SegmentPersistenceError) return persistenceErrorResponse(c, error);
      return c.json(errorBody('SEGMENT_RESTORE_FAILED', 'Unable to restore segment split.'), 500);
    }
  });

  return routes;
}
