import { describe, expect, it } from 'vitest';
import type { AiBinding, AiRunOptions } from '../src/cloudflare/ai';
import { createVoiceProvider } from '../src/services/voice/provider';

class FakeAI implements AiBinding {
  calls: Array<{ model: string; input: unknown; options?: AiRunOptions }> = [];

  async run(model: string, input: unknown, options?: AiRunOptions): Promise<unknown> {
    this.calls.push({ model, input, options });
    return { state: 'Completed', result: { audio: 'https://audio.test/grok.pcm' } };
  }
}

describe('paid Grok TTS opt-in', () => {
  it('fails closed by default and does not advertise Vietnamese TTS as configured', () => {
    const provider = createVoiceProvider({ AI: new FakeAI() });

    expect(provider.capabilities()).toEqual(expect.objectContaining({
      provider: 'workers-ai',
      configured: false,
      languages: 'unknown',
    }));
  });

  it('does not call the AI binding when paid Grok TTS is disabled', async () => {
    const ai = new FakeAI();
    const provider = createVoiceProvider({ AI: ai });

    await expect(provider.generate({
      text: 'Xin chào',
      language: 'vi',
      outputFormat: 'pcm_24000',
    })).rejects.toMatchObject({ code: 'VOICE_LANGUAGE_UNVERIFIED' });
    expect(ai.calls).toHaveLength(0);
  });

  it('keeps the qualified Grok fallback available after explicit opt-in', () => {
    const provider = createVoiceProvider({
      AI: new FakeAI(),
      PAID_GROK_TTS_ENABLED: 'true',
    } as never);

    expect(provider.capabilities()).toEqual(expect.objectContaining({
      provider: 'workers-ai',
      configured: true,
      languages: ['vi'],
    }));
  });
});
