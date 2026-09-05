import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  SegmentPersistenceError,
  type Segment,
  type SegmentStore,
} from '../src/db/segments';
import type { SegmentPatch, SegmentRestoreInput } from '../src/domain/segment';
import { createSegmentRoutes } from '../src/routes/segments';

const baseSegment: Segment = {
  id: 's1',
  projectId: 'project-1',
  speakerId: 'speaker-1',
  startMs: 1_000,
  endMs: 3_000,
  sourceText: 'hello world',
  translatedText: 'xin chao',
  translationEngine: 'workers-ai',
  translationContextRevision: null,
  translationStatus: 'completed',
  voiceStatus: 'completed',
  dubbedObjectKey: 'projects/project-1/dubbed/s1.mp3',
  version: 1,
  splitParentId: null,
};

class MemorySegmentStore implements SegmentStore {
  calls: Array<{ method: string; args: unknown[] }> = [];
  updateError: Error | null = null;
  current: Segment = baseSegment;

  async list() { return [this.current]; }

  async get(_projectId: string, segmentId: string, userId: string) {
    if (segmentId !== 's1' || userId !== 'dev-user') return null;
    return this.current;
  }

  async updateText(): Promise<Segment | null> {
    throw new Error('legacy updateText must not be used by segment routes');
  }

  async updateSegment(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    patch: SegmentPatch,
  ) {
    this.calls.push({ method: 'updateSegment', args: [projectId, segmentId, userId, expectedVersion, patch] });
    if (this.updateError) throw this.updateError;
    if (expectedVersion !== this.current.version) {
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
    const invalidatesVoice = patch.startMs !== undefined
      || patch.endMs !== undefined
      || patch.translatedText !== undefined
      || patch.speakerId !== undefined;
    this.current = {
      ...this.current,
      ...patch,
      voiceStatus: invalidatesVoice ? 'pending' : this.current.voiceStatus,
      dubbedObjectKey: invalidatesVoice ? null : this.current.dubbedObjectKey,
      version: this.current.version + 1,
    };
    return this.current;
  }

  async splitSegment(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    playheadMs: number,
  ) {
    this.calls.push({ method: 'splitSegment', args: [projectId, segmentId, userId, expectedVersion, playheadMs] });
    return {
      left: { ...baseSegment, endMs: playheadMs, voiceStatus: 'pending', dubbedObjectKey: null, version: expectedVersion + 1 },
      right: {
        ...baseSegment,
        id: 'worker-child',
        startMs: playheadMs,
        sourceText: 'world',
        translatedText: 'chao',
        voiceStatus: 'pending',
        dubbedObjectKey: null,
        version: 1,
        splitParentId: segmentId,
      },
    };
  }

  async restoreSplit(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    childSegmentId: string,
    expectedChildVersion: number,
    original: SegmentRestoreInput,
  ) {
    this.calls.push({
      method: 'restoreSplit',
      args: [projectId, segmentId, userId, expectedVersion, childSegmentId, expectedChildVersion, original],
    });
    return { ...baseSegment, ...original, voiceStatus: 'pending', dubbedObjectKey: null, version: expectedVersion + 1 };
  }

  async setTranslationResult() { return null; }
  async setVoiceResult() {}
  async replaceFromAsr() { return []; }
}

function makeApp(store: SegmentStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createSegmentRoutes(() => store));
  return app;
}

describe('segment mutation routes', () => {
  it('requires an expected revision and routes the inner PATCH through repository validation', async () => {
    const store = new MemorySegmentStore();
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, patch: { startMs: 1_200, endMs: 3_200 } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      startMs: 1_200,
      endMs: 3_200,
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version: 2,
    });
    expect(store.calls).toEqual([
      { method: 'updateSegment', args: ['project-1', 's1', 'dev-user', 1, { startMs: 1_200, endMs: 3_200 }] },
    ]);
  });

  it('rejects a PATCH without a positive integer expectedVersion', async () => {
    const store = new MemorySegmentStore();
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { translatedText: 'new' } }),
    });

    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('returns 409 with the fresh canonical server segment for a stale revision', async () => {
    const store = new MemorySegmentStore();
    store.current = { ...baseSegment, translatedText: 'server-new', version: 2 };
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, patch: { translatedText: 'local-old' } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: true,
      code: 'SEGMENT_VERSION_CONFLICT',
      message: 'Segment changed elsewhere.',
      segment: store.current,
    });
  });

  it('exposes the dedicated revision-aware Worker split endpoint', async () => {
    const store = new MemorySegmentStore();
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1/split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, playheadMs: 2_000 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { left: Segment; right: Segment };
    expect(body.left.endMs).toBe(2_000);
    expect(body.right).toMatchObject({ id: 'worker-child', startMs: 2_000, splitParentId: 's1', dubbedObjectKey: null });
    expect(store.calls).toContainEqual({ method: 'splitSegment', args: ['project-1', 's1', 'dev-user', 1, 2_000] });
  });

  it('exposes revision-aware restore-split with parent and child revisions', async () => {
    const store = new MemorySegmentStore();
    const original: SegmentRestoreInput = {
      startMs: 1_000,
      endMs: 3_000,
      sourceText: 'hello world',
      translatedText: 'xin chao',
      speakerId: 'speaker-1',
    };
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1/restore-split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        childSegmentId: 'worker-child',
        expectedChildVersion: 1,
        original,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 's1', voiceStatus: 'pending', dubbedObjectKey: null });
    expect(store.calls).toContainEqual({
      method: 'restoreSplit',
      args: ['project-1', 's1', 'dev-user', 1, 'worker-child', 1, original],
    });
  });

  it('maps stable persistence errors instead of hiding them behind a generic 500', async () => {
    const store = new MemorySegmentStore();
    store.updateError = new SegmentPersistenceError('SEGMENT_OVERLAP', 'Segment overlaps s2.');
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, patch: { startMs: 2_500, endMs: 4_500 } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: true,
      code: 'SEGMENT_OVERLAP',
      message: 'Segment overlaps s2.',
    });
  });

  it('maps a project processing lock to HTTP 409 without weakening the revision envelope', async () => {
    const store = new MemorySegmentStore();
    store.updateError = new SegmentPersistenceError('PROJECT_BUSY', 'Project is locked while cloud processing or export is active.');
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, patch: { translatedText: 'locked' } }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PROJECT_BUSY' });
  });
});
