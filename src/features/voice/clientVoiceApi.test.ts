import { describe, expect, it, vi } from 'vitest';
import { canonicalClientVoiceObjectKey, uploadClientVoicePcm } from './clientVoiceApi';

describe('client voice PCM API', () => {
  it('builds the canonical exact-version R2 object key', () => {
    expect(canonicalClientVoiceObjectKey('p1', 's1', 3)).toBe('projects/p1/voices/vi/s1/3.pcm');
  });

  it('uploads only the requested byte slice with exact PCM headers', async () => {
    const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
    const pcm = backing.subarray(1, 5);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
      targetLanguage: 'vi',
      segmentId: 's/1',
      version: 7,
      voiceStatus: 'completed',
      objectKey: 'projects/p 1/voices/vi/s/1/7.pcm',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await uploadClientVoicePcm({ projectId: 'p 1', segmentId: 's/1', version: 7, pcm }, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0];
    expect(path).toBe('/api/projects/p%201/translations/vi/s%2F1/voice-pcm');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'X-DubFlow-PCM-Format': 's16le',
      'X-DubFlow-PCM-Sample-Rate': '24000',
      'X-DubFlow-PCM-Channels': '1',
      'X-DubFlow-Translation-Version': '7',
    });
    expect([...new Uint8Array(init?.body as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
  });
});
