import { afterEach, describe, expect, it, vi } from 'vitest';
import * as segmentApi from './segmentApi';
import { retranslateSegment } from '../translation/translationApi';

afterEach(() => vi.unstubAllGlobals());

const segment = {
  id: 'seg-1', projectId: 'p', speakerId: null, startMs: 0, endMs: 1000,
  sourceText: '你好', translatedText: 'Xin chào', translationEngine: 'workers-ai',
  translationStatus: 'completed', voiceStatus: 'pending', version: 2, splitParentId: null,
};

describe('segment API', () => {
  it('lists and patches persisted segments with encoded paths and revision preconditions', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return calls.length === 1 ? Response.json([segment]) : Response.json({ ...segment, translatedText: 'Chào bạn', version: 3 });
    });

    await expect(segmentApi.listSegments('p / 1')).resolves.toEqual([segment]);
    await expect(segmentApi.patchSegment('p / 1', 'seg / 1', 2, { translatedText: 'Chào bạn' })).resolves.toMatchObject({ translatedText: 'Chào bạn', version: 3 });
    expect(calls[0].input).toBe('/api/projects/p%20%2F%201/segments');
    expect(calls[1].input).toBe('/api/projects/p%20%2F%201/segments/seg%20%2F%201');
    expect(calls[1].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      expectedVersion: 2,
      patch: { translatedText: 'Chào bạn' },
    });
  });

  it('converts a well-formed 409 revision conflict into a typed error with the canonical segment', async () => {
    const canonical = { ...segment, translatedText: 'Bản mới', version: 8 };
    vi.stubGlobal('fetch', async () => Response.json({
      code: 'SEGMENT_VERSION_CONFLICT',
      message: 'stale segment',
      segment: canonical,
    }, { status: 409 }));

    await expect(segmentApi.patchSegment('p', 'seg-1', 7, { translatedText: 'Bản cũ' }))
      .rejects.toMatchObject({
        name: 'SegmentVersionConflictError',
        code: 'SEGMENT_VERSION_CONFLICT',
        canonical: { id: 'seg-1', version: 8, translatedText: 'Bản mới' },
      });
  });

  it('keeps malformed revision conflicts fail-closed as the original API error', async () => {
    vi.stubGlobal('fetch', async () => Response.json({
      code: 'SEGMENT_VERSION_CONFLICT',
      message: 'stale segment',
      segment: { id: 'seg-1' },
    }, { status: 409 }));

    await expect(segmentApi.patchSegment('p', 'seg-1', 7, { translatedText: 'Bản cũ' }))
      .rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'SEGMENT_VERSION_CONFLICT' });
  });

  it('sends parent and child revision preconditions to split and restore-split endpoints', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (calls.length === 1) {
        return Response.json({
          left: { ...segment, id: 'seg / 1', endMs: 500, version: 3 },
          right: { ...segment, id: 'worker-child', startMs: 500, splitParentId: 'seg / 1', version: 1 },
        });
      }
      return Response.json({ ...segment, id: 'seg / 1', version: 4 });
    });

    await segmentApi.splitSegment('p / 1', 'seg / 1', 2, 500);
    await segmentApi.restoreSplit('p / 1', 'seg / 1', 3, 'worker / child', 1, {
      startMs: 0,
      endMs: 1000,
      sourceText: '你好',
      translatedText: 'Xin chào',
      speakerId: null,
    });

    expect(calls[0].input).toBe('/api/projects/p%20%2F%201/segments/seg%20%2F%201/split');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ expectedVersion: 2, playheadMs: 500 });
    expect(calls[1].input).toBe('/api/projects/p%20%2F%201/segments/seg%20%2F%201/restore-split');
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      expectedVersion: 3,
      childSegmentId: 'worker / child',
      expectedChildVersion: 1,
      original: {
        startMs: 0,
        endMs: 1000,
        sourceText: '你好',
        translatedText: 'Xin chào',
        speakerId: null,
      },
    });
  });

  it('sends the expected revision for compare translation without implying a persisted overwrite', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return Response.json({
        mode: 'compare',
        workersAI: [{ id: 'seg-1', text: 'Bản AI', provider: 'workers-ai' }],
        google: [{ id: 'seg-1', text: 'Bản Google', provider: 'google' }],
      });
    });
    const result = await retranslateSegment('p', 'seg-1', 2, 'compare');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ expectedVersion: 2, mode: 'compare' });
    expect(result.mode).toBe('compare');
    if (result.mode === 'compare') {
      expect(result.workersAI[0].text).toBe('Bản AI');
      expect(result.google[0].text).toBe('Bản Google');
    }
  });

  it('surfaces a stale persisted retranslation as the typed segment conflict', async () => {
    const canonical = { ...segment, translatedText: 'Bản mới trên server', version: 3 };
    vi.stubGlobal('fetch', async () => Response.json({
      code: 'SEGMENT_VERSION_CONFLICT',
      message: 'stale segment',
      segment: canonical,
    }, { status: 409 }));

    await expect(retranslateSegment('p', 'seg-1', 2, 'workers-ai'))
      .rejects.toMatchObject({
        name: 'SegmentVersionConflictError',
        canonical: { id: 'seg-1', version: 3, translatedText: 'Bản mới trên server' },
      });
  });
});
