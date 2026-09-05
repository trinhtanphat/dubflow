import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { SegmentPersistenceError, type Segment } from '../src/db/segments';
import { createSegmentRoutes } from '../src/routes/segments';

const canonical: Segment = {
  id: 's1',
  projectId: 'p1',
  speakerId: null,
  startMs: 0,
  endMs: 1_000,
  sourceText: 'hello world',
  translatedText: 'xin chao',
  translationEngine: 'workers-ai',
  translationStatus: 'completed',
  voiceStatus: 'pending',
  version: 4,
  splitParentId: null,
};

function makeApp(store: any) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createSegmentRoutes(() => store));
  return app;
}

describe('revision-aware structural segment routes', () => {
  it('passes the parent revision to split persistence', async () => {
    const calls: unknown[] = [];
    const store = {
      async get() { return canonical; },
      async splitSegment(projectId: string, segmentId: string, userId: string, expectedVersion: number, playheadMs: number) {
        calls.push({ projectId, segmentId, userId, expectedVersion, playheadMs });
        return {
          left: { ...canonical, endMs: playheadMs, version: expectedVersion + 1 },
          right: { ...canonical, id: 'child', startMs: playheadMs, version: 1, splitParentId: segmentId },
        };
      },
    };

    const response = await makeApp(store).request('/api/projects/p1/segments/s1/split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 4, playheadMs: 500 }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{ projectId: 'p1', segmentId: 's1', userId: 'dev-user', expectedVersion: 4, playheadMs: 500 }]);
  });

  it('passes parent and child revisions to restore persistence', async () => {
    const calls: unknown[] = [];
    const original = { startMs: 0, endMs: 1_000, sourceText: 'hello world', translatedText: 'xin chao', speakerId: null };
    const store = {
      async get() { return canonical; },
      async restoreSplit(
        projectId: string,
        segmentId: string,
        userId: string,
        expectedVersion: number,
        childSegmentId: string,
        expectedChildVersion: number,
        snapshot: typeof original,
      ) {
        calls.push({ projectId, segmentId, userId, expectedVersion, childSegmentId, expectedChildVersion, snapshot });
        return { ...canonical, version: expectedVersion + 1 };
      },
    };

    const response = await makeApp(store).request('/api/projects/p1/segments/s1/restore-split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 4, childSegmentId: 'child', expectedChildVersion: 1, original }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      projectId: 'p1', segmentId: 's1', userId: 'dev-user', expectedVersion: 4,
      childSegmentId: 'child', expectedChildVersion: 1, snapshot: original,
    }]);
  });

  it('returns the canonical parent on a structural revision conflict', async () => {
    const store = {
      async get() { return canonical; },
      async splitSegment() {
        throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
      },
    };

    const response = await makeApp(store).request('/api/projects/p1/segments/s1/split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, playheadMs: 500 }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: true,
      code: 'SEGMENT_VERSION_CONFLICT',
      message: 'Segment changed elsewhere.',
      segment: canonical,
    });
  });
});
