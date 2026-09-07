import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { WorkersAIAsrProvider, WORKERS_AI_ASR_MODEL } from '../src/services/asr/workers-ai';

class CapturingAI implements AiBinding {
  calls: Array<{ model: string; input: Record<string, unknown> }> = [];

  async run(model: string, input: unknown): Promise<unknown> {
    this.calls.push({ model, input: input as Record<string, unknown> });
    return {
      text: 'hello',
      segments: [{ start: 0, end: 1, text: 'hello' }],
    };
  }
}

describe('Workers AI turbo ASR payload', () => {
  it('sends whisper-large-v3-turbo audio as base64 instead of a raw ArrayBuffer', async () => {
    const ai = new CapturingAI();
    const provider = new WorkersAIAsrProvider(ai, true);

    await provider.transcribe(new Uint8Array([1, 2, 3]).buffer, { sourceLanguage: 'en' });

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toEqual({
      model: WORKERS_AI_ASR_MODEL,
      input: {
        audio: 'AQID',
        task: 'transcribe',
        language: 'en',
        vad_filter: true,
      },
    });
  });
});
