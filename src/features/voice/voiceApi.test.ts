import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { fetchVoiceCapabilities, fetchVoicePreview, uploadClientVoicePcm } from './voiceApi';

describe('voiceApi', () => {
  it('loads live voice capabilities from the Worker including managed clone enrollment', async () => {
    const payload = {
      provider: 'elevenlabs',
      configured: true,
      languages: ['vi'],
      cloning: true,
      preview: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
    } as const;
    const fetcher = vi.fn(async () => Response.json(payload));
    await expect(fetchVoiceCapabilities(fetcher as typeof fetch)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith('/api/voice/capabilities', expect.anything());
  });

  it('requests a Vietnamese audio preview and returns the audio blob', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'Xin chào', language: 'vi' });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    });
    const blob = await fetchVoicePreview({ text: 'Xin chào', language: 'vi' }, fetcher as typeof fetch);
    expect(blob.type).toContain('audio/mpeg');
    expect(blob.size).toBe(3);
  });

  it('surfaces fail-closed preview errors', async () => {
    const fetcher = vi.fn(async () => Response.json({
      code: 'VOICE_PROVIDER_UNCONFIGURED', message: 'Voice provider is not configured.',
    }, { status: 503 }));
    await expect(fetchVoicePreview({ text: 'Xin chào', language: 'vi' }, fetcher as typeof fetch)).rejects.toMatchObject({
      status: 503,
      code: 'VOICE_PROVIDER_UNCONFIGURED',
    });
  });

  it('uploads byte-identical exact-version 24 kHz mono s16le PCM to the Vietnamese cache route', async () => {
    const pcm = new Uint8Array([0, 1, 254, 255]);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/projects/project%2Fone/translations/vi/segment%2Fone/voice-pcm');
      expect(init?.method).toBe('PUT');
      expect(init?.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'X-DubFlow-PCM-Format': 's16le',
        'X-DubFlow-PCM-Sample-Rate': '24000',
        'X-DubFlow-PCM-Channels': '1',
        'X-DubFlow-Translation-Version': '7',
      });
      expect([...new Uint8Array(init?.body as ArrayBuffer)]).toEqual([...pcm]);
      return Response.json({
        targetLanguage: 'vi', segmentId: 'segment/one', version: 7, voiceStatus: 'completed', objectKey: 'voice.pcm',
      });
    });

    await expect(uploadClientVoicePcm('project/one', 'segment/one', 7, pcm, fetcher as typeof fetch)).resolves.toMatchObject({
      targetLanguage: 'vi', segmentId: 'segment/one', version: 7, voiceStatus: 'completed', objectKey: 'voice.pcm',
    });
  });

  it('surfaces stale translation conflicts without provider fallback', async () => {
    const fetcher = vi.fn(async () => Response.json({
      code: 'TRANSLATION_VARIANT_CONFLICT', message: 'Translation variant changed on the server.',
    }, { status: 409 }));

    const promise = uploadClientVoicePcm('p1', 's1', 2, new Uint8Array([0, 0]), fetcher as typeof fetch);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 409, code: 'TRANSLATION_VARIANT_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
