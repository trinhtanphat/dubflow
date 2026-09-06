import { describe, expect, it, vi } from 'vitest';
import { fetchVoiceCapabilities, fetchVoicePreview } from './voiceApi';

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
});
