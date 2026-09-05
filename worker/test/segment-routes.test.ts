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
  translationStatus: 'completed',
  voiceStatus: 'completed',
  dubbedObjectKey: 'projects/project-1/dubbed/s1.mp3',
  version: 1,
  splitParentId: null,
};

class MemorySegmentStore implements SegmentStore {
  calls: Array<{ method: string; args: unknown[] }> = [];
  updateError: Error | null = null;

  async list() {
    return [baseSegment];
  }

  async get(_projectId: string, segmentId: string, userId: string) {
    if (segmentId !== 's1' || userId !== 'dev-user') return null;
    return baseSegment;
  }

  async updateText(): Promise<Segment | null> {
    throw new Error('legacy updateText must not be used by segment routes');
  }

  async updateSegment(projectId: string, segmentId: string, userId: string, patch: SegmentPatch) {
    this.calls.push({ method: 'updateSegment', args: [projectId, segmentId, userId, patch] });
    if (this.updateError) throw this.updateError;
    const invalidatesVoice = patch.startMs !== undefined || patch.endMs !== undefined || patch.translatedText !== undefined || patch.speakerId !== undefined;
    return {
      ...baseSegment,
      ...patch,
      voiceStatus: invalidatesVoice ? 'pending' : baseSegment.voiceStatus,
      dubbedObjectKey: invalidatesVoice ? null : baseSegment.dubbedObjectKey,
      version: 2,
    };
  }

  async splitSegment(projectId: string, segmentId: string, userId: string, playheadMs: number) {
    this.calls.push({ method: 'splitSegment', args: [projectId, segmentId, userId, playheadMs] });
    return {
      left: { ...baseSegment, endMs: playheadMs, voiceStatus: 'pending', dubbedObjectKey: null, version: 2 },
      right: {
        ...baseSegment,
        id: 'worker-child',
        startMs: playheadMs,
        sourceText: 'world',
        translatedText: 'chao',
        voiceStatus: 'pending',
        dubbedObjectKey: null,
        splitParentId: segmentId,
      },
    };
  }

  async restoreSplit(
    projectId: string,
    segmentId: string,
    childSegmentId: string,
    userId: string,
    original: SegmentRestoreInput,
  ) {
    this.calls.push({ method: 'restoreSplit', args: [projectId, segmentId, childSegmentId, userId, original] });
    return { ...baseSegment, ...original, voiceStatus: 'pending', dubbedObjectKey: null, version: 3 };
  }

  async setTranslationResult() {
    return null;
  }

  async setVoiceResult() {}

  async replaceFromAsr() {
    return [];
  }
}

function makeApp(store: SegmentStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createSegmentRoutes(() => store));
  return app;
}

describe('segment mutation routes', () => {
  it('routes PATCH timing edits through current-state repository validation', async () => {
    const store = new MemorySegmentStore();
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startMs: 1_200, endMs: 3_200 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ startMs: 1_200, endMs: 3_200, voiceStatus: 'pending', dubbedObjectKey: null });
    expect(store.calls).toEqual([
      { method: 'updateSegment', args: ['project-1', 's1', 'dev-user', { startMs: 1_200, endMs: 3_200 }] },
    ]);
  });

  it('exposes the dedicated Worker split endpoint', async () => {
    const store = new MemorySegmentStore();
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1/split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playheadMs: 2_000 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { left: Segment; right: Segment };
    expect(body.left.endMs).toBe(2_000);
    expect(body.right).toMatchObject({ id: 'worker-child', startMs: 2_000, splitParentId: 's1', dubbedObjectKey: null });
    expect(store.calls).toContainEqual({ method: 'splitSegment', args: ['project-1', 's1', 'dev-user', 2_000] });
  });

  it('exposes narrow restore-split with child id and original snapshot', async () => {
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
      body: JSON.stringify({ childSegmentId: 'worker-child', original }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 's1', voiceStatus: 'pending', dubbedObjectKey: null });
    expect(store.calls).toContainEqual({
      method: 'restoreSplit',
      args: ['project-1', 's1', 'worker-child', 'dev-user', original],
    });
  });

  it('maps stable persistence errors instead of hiding them behind a generic 500', async () => {
    const store = new MemorySegmentStore();
    store.updateError = new SegmentPersistenceError('SEGMENT_OVERLAP', 'Segment overlaps s2.');
    const response = await makeApp(store).request('/api/projects/project-1/segments/s1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startMs: 2_500, endMs: 4_500 }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: true,
      code: 'SEGMENT_OVERLAP',
      message: 'Segment overlaps s2.',
    });
  });
});
