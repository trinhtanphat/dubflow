import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { WorkersAIAsrProvider } from '../src/services/asr/workers-ai';

class CapturingAI implements AiBinding {
  input: unknown = null;

  async run(_model: string, input: unknown): Promise<unknown> {
    this.input = input;
    return {
      text: 'hello',
      segments: [{ start: 0, end: 1, text: 'hello' }],
    };
  }
}

describe('Workers AI ASR production payload contract', () => {
  it('wraps source bytes in the binary object payload with the real media type', async () => {
    const ai = new CapturingAI();
    const provider = new WorkersAIAsrProvider(ai);
    const audio = new Uint8Array([0, 1, 2, 3]).buffer;

    await provider.transcribe(audio, {
      sourceLanguage: 'en',
      mediaType: 'video/mp4',
    } as any);

    expect(ai.input).toMatchObject({
      audio: {
        body: audio,
        contentType: 'video/mp4',
      },
      task: 'transcribe',
      language: 'en',
      vad_filter: true,
    });
  });
});
