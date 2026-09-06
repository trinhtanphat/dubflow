import { describe, expect, it } from 'vitest';
import { ElevenLabsVoiceProvider } from '../src/services/voice/elevenlabs';

describe('ElevenLabs voice provider', () => {
  it('reports preview and managed IVC enrollment as separate capabilities', () => {
    const provider = new ElevenLabsVoiceProvider('secret', { defaultVoiceId: 'voice-123' }, async () => new Response('audio'));
    expect(provider.capabilities()).toEqual({
      provider: 'elevenlabs',
      configured: true,
      languages: ['vi'],
      cloning: true,
      preview: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
    });
  });

  it('can expose managed enrollment without falsely claiming preview is configured', () => {
    const provider = new ElevenLabsVoiceProvider('secret', {}, async () => new Response('audio'));
    expect(provider.capabilities()).toMatchObject({
      configured: false,
      preview: false,
      cloning: true,
      cloneEnrollment: { mode: 'ivc', available: true },
    });
  });

  it('creates Vietnamese speech through the configured voice without leaking the API key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new ElevenLabsVoiceProvider(
      'secret-key',
      { defaultVoiceId: 'voice-123' },
      async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      },
    );

    const response = await provider.generate({ text: 'Xin chào', language: 'vi' });
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('content-type')).toContain('audio');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/v1/text-to-speech/voice-123');
    expect(calls[0].url).not.toContain('secret-key');
    expect(new Headers(calls[0].init?.headers).get('xi-api-key')).toBe('secret-key');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ text: 'Xin chào', model_id: 'eleven_multilingual_v2', language_code: 'vi' });
  });

  it('fails closed when ElevenLabs is not configured', async () => {
    const provider = new ElevenLabsVoiceProvider('', {}, async () => new Response('audio'));
    expect(provider.capabilities()).toMatchObject({
      provider: 'elevenlabs',
      configured: false,
      preview: false,
      cloning: false,
      cloneEnrollment: { available: false },
    });
    await expect(provider.generate({ text: 'Xin chào', language: 'vi' })).rejects.toMatchObject({ code: 'VOICE_PROVIDER_UNCONFIGURED' });
  });
});
