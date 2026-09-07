import { describe, expect, it } from 'vitest';
import { ElevenLabsVoiceProvider } from '../src/services/voice/elevenlabs';

describe('ElevenLabs PCM export output', () => {
  it('requests raw 24 kHz PCM for export while preserving the qualified voice request body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new ElevenLabsVoiceProvider('key', { defaultVoiceId: 'voice-1' }, async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 });
    });

    await provider.generate({ text: 'Xin chào', language: 'vi', outputFormat: 'pcm_24000' });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('output_format')).toBe('pcm_24000');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      text: 'Xin chào',
      language_code: 'vi',
    });
  });
});
