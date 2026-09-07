import { describe, expect, it, vi } from 'vitest';
import { createVoiceProvider } from '../src/services/voice/provider';

const fakeAi = () => ({ run: vi.fn() });

describe('createVoiceProvider paid TTS admission', () => {
  it('fails closed by default before any paid provider can be selected', async () => {
    const ai = fakeAi();
    const provider = createVoiceProvider({
      AI: ai,
      ELEVENLABS_API_KEY: 'configured-key',
      ELEVENLABS_DEFAULT_VOICE_ID: 'configured-voice',
    });

    expect(provider.capabilities().configured).toBe(false);
    await expect(provider.generate({
      text: 'xin chao',
      language: 'vi',
      outputFormat: 'pcm_24000',
    })).rejects.toMatchObject({ code: 'VOICE_PROVIDER_UNCONFIGURED' });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('allows the configured paid provider only after explicit opt-in', () => {
    const provider = createVoiceProvider({
      ALLOW_PAID_TTS: 'true',
      ELEVENLABS_API_KEY: 'configured-key',
      ELEVENLABS_DEFAULT_VOICE_ID: 'configured-voice',
    } as any);

    expect(provider.capabilities()).toMatchObject({
      provider: 'elevenlabs',
      configured: true,
    });
  });

  it('allows the Grok fallback only after explicit opt-in', () => {
    const provider = createVoiceProvider({
      ALLOW_PAID_TTS: 'true',
      AI: fakeAi(),
    } as any);

    expect(provider.capabilities()).toMatchObject({
      provider: 'xai/grok-tts',
      configured: true,
      languages: ['vi'],
    });
  });
});
