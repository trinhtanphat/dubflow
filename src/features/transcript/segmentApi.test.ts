import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSegments, patchSegment } from './segmentApi';
import { retranslateSegment } from '../translation/translationApi';

afterEach(() => vi.unstubAllGlobals());

const segment = {
  id: 'seg-1', projectId: 'p', speakerId: null, startMs: 0, endMs: 1000,
  sourceText: '你好', translatedText: 'Xin chào', translationEngine: 'workers-ai',
  translationStatus: 'completed', voiceStatus: 'pending', version: 2,
};

describe('segment API', () => {
  it('lists and patches persisted segments with encoded project/segment paths', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return calls.length === 1 ? Response.json([segment]) : Response.json({ ...segment, translatedText: 'Chào bạn', version: 3 });
    });

    await expect(listSegments('p / 1')).resolves.toEqual([segment]);
    await expect(patchSegment('p / 1', 'seg / 1', { translatedText: 'Chào bạn' })).resolves.toMatchObject({ translatedText: 'Chào bạn', version: 3 });
    expect(calls[0].input).toBe('/api/projects/p%20%2F%201/segments');
    expect(calls[1].input).toBe('/api/projects/p%20%2F%201/segments/seg%20%2F%201');
    expect(calls[1].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ translatedText: 'Chào bạn' });
  });

  it('returns a typed compare result without implying a persisted overwrite', async () => {
    vi.stubGlobal('fetch', async () => Response.json({
      mode: 'compare',
      workersAI: [{ id: 'seg-1', text: 'Bản AI', provider: 'workers-ai' }],
      google: [{ id: 'seg-1', text: 'Bản Google', provider: 'google' }],
    }));
    const result = await retranslateSegment('p', 'seg-1', 'compare');
    expect(result.mode).toBe('compare');
    if (result.mode === 'compare') {
      expect(result.workersAI[0].text).toBe('Bản AI');
      expect(result.google[0].text).toBe('Bản Google');
    }
  });
});
