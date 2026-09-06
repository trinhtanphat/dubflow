import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { WorkersAIVoiceProvider } from '../src/services/voice/workers-ai';

class FakeAI implements AiBinding {
  calls = 0;
  async run(): Promise<unknown> { this.calls += 1; return new Response('audio'); }
}

describe('voice capability gate', () => {
  it('does not claim cloning and rejects Vietnamese until explicitly verified', async () => {
    const ai = new FakeAI();
    const provider = new WorkersAIVoiceProvider(ai, { model: '@cf/deepgram/aura-1', verifiedLanguages: [] });
    expect(provider.capabilities()).toEqual({
      provider: 'workers-ai',
      configured: true,
      languages: [],
      cloning: false,
      preview: false,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
    });
    await expect(provider.generate({ text: 'Xin chào', language: 'vi' })).rejects.toMatchObject({ code: 'VOICE_LANGUAGE_UNVERIFIED' });
    expect(ai.calls).toBe(0);
  });

  it('exposes unknown capabilities when no live qualification exists', () => {
    const provider = new WorkersAIVoiceProvider(new FakeAI());
    expect(provider.capabilities()).toEqual({
      provider: 'workers-ai',
      configured: false,
      languages: 'unknown',
      cloning: false,
      preview: false,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
    });
  });
});
