import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreSplit, splitSegment } from './segmentApi';
import { retranslateSegment } from '../translation/translationApi';

const original = {
  startMs: 0,
  endMs: 1_000,
  sourceText: 'hello world',
  translatedText: 'xin chao',
  speakerId: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('revision-aware structural mutation APIs', () => {
  it('sends parent and child revision preconditions for split and restore', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (calls.length === 1) {
        return Response.json({
          left: { id: 's1', projectId: 'p1', speakerId: null, startMs: 0, endMs: 500, sourceText: 'hello', translatedText: 'xin', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 4, splitParentId: null },
          right: { id: 'child', projectId: 'p1', speakerId: null, startMs: 500, endMs: 1_000, sourceText: 'world', translatedText: 'chao', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 1, splitParentId: 's1' },
        });
      }
      return Response.json({ id: 's1', projectId: 'p1', speakerId: null, startMs: 0, endMs: 1_000, sourceText: 'hello world', translatedText: 'xin chao', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 5, splitParentId: null });
    });

    await (splitSegment as any)('p1', 's1', 3, 500);
    await (restoreSplit as any)('p1', 's1', 4, 'child', 1, original);

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ expectedVersion: 3, playheadMs: 500 });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      expectedVersion: 4,
      childSegmentId: 'child',
      expectedChildVersion: 1,
      original,
    });
  });

  it('sends the canonical revision with persisted retranslation requests', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return Response.json({
        mode: 'workers-ai',
        result: { id: 's1', text: 'ban moi', provider: 'workers-ai' },
        segment: { id: 's1', projectId: 'p1', speakerId: null, startMs: 0, endMs: 1_000, sourceText: 'hello', translatedText: 'ban moi', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 4 },
      });
    });

    await (retranslateSegment as any)('p1', 's1', 3, 'workers-ai');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ expectedVersion: 3, mode: 'workers-ai' });
  });
});
