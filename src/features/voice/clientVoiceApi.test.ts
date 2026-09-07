import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { CLIENT_PCM_MAX_BYTES } from './clientPcm';
import { uploadVietnameseVoicePcm } from './clientVoiceApi';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('uploadVietnameseVoicePcm', () => {
  it('uploads exact raw bytes to the versioned Vietnamese PCM endpoint with all required headers', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      targetLanguage: 'vi',
      segmentId: 'seg/1',
      version: 3,
      voiceStatus: 'completed',
      objectKey: 'projects/p 1/voices/vi/seg%2F1/3.pcm',
    })) as unknown as typeof fetch;
    const pcm = new Uint8Array([1, 2, 3, 4]);

    await uploadVietnameseVoicePcm('p 1', 'seg/1', 3, pcm, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/projects/p%201/translations/vi/seg%2F1/voice-pcm');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({
      'content-type': 'application/octet-stream',
      'X-DubFlow-PCM-Format': 's16le',
      'X-DubFlow-PCM-Sample-Rate': '24000',
      'X-DubFlow-PCM-Channels': '1',
      'X-DubFlow-Translation-Version': '3',
    });
    expect([...new Uint8Array(init.body as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
  });

  it('rejects invalid version and malformed bounded PCM before network access', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(uploadVietnameseVoicePcm('p1', 's1', 0, new Uint8Array([1, 2]), fetchImpl)).rejects.toThrow(/version/i);
    await expect(uploadVietnameseVoicePcm('p1', 's1', 1, new Uint8Array(), fetchImpl)).rejects.toThrow(/empty/i);
    await expect(uploadVietnameseVoicePcm('p1', 's1', 1, new Uint8Array([1]), fetchImpl)).rejects.toThrow(/even/i);
    await expect(uploadVietnameseVoicePcm('p1', 's1', 1, new Uint8Array(CLIENT_PCM_MAX_BYTES + 2), fetchImpl)).rejects.toThrow(/8 MiB/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves translation version conflicts as ApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 'TRANSLATION_VARIANT_CONFLICT',
      message: 'Translation variant changed on the server.',
    }, 409)) as unknown as typeof fetch;

    const error = await uploadVietnameseVoicePcm('p1', 's1', 2, new Uint8Array([0, 0]), fetchImpl)
      .then(() => null, (value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'TRANSLATION_VARIANT_CONFLICT' });
  });
});
