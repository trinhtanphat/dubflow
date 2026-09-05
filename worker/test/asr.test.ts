import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { WorkersAIAsrProvider } from '../src/services/asr/workers-ai';
import { normalizeAsrChunks } from '../src/services/asr/normalize';

class FakeAI implements AiBinding {
  calls: { model: string; input: any }[] = [];
  async run(model: string, input: unknown): Promise<unknown> {
    this.calls.push({ model, input });
    return { text: 'hello', segments: [{ start: 0.5, end: 1.25, text: 'hello' }] };
  }
}

describe('Workers AI ASR', () => {
  it('uses whisper-large-v3-turbo in transcribe mode with VAD and optional language', async () => {
    const ai = new FakeAI();
    const provider = new WorkersAIAsrProvider(ai);
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const result = await provider.transcribe(audio, { sourceLanguage: 'zh' });
    expect(ai.calls[0]).toMatchObject({
      model: '@cf/openai/whisper-large-v3-turbo',
      input: { audio, task: 'transcribe', language: 'zh', vad_filter: true },
    });
    expect(result.segments).toEqual([{ startMs: 500, endMs: 1250, text: 'hello' }]);
  });

  it('omits language when auto detection is requested', async () => {
    const ai = new FakeAI();
    const provider = new WorkersAIAsrProvider(ai);
    await provider.transcribe(new ArrayBuffer(0), { sourceLanguage: 'auto' });
    expect('language' in ai.calls[0].input).toBe(false);
  });
});

describe('ASR chunk normalization', () => {
  it('applies each chunk offset once and produces stable monotonic ids', () => {
    const chunks = [{
      projectId: 'p1', chunkId: 'c1', offsetMs: 10_000,
      segments: [
        { startMs: 100, endMs: 700, text: 'one' },
        { startMs: 800, endMs: 1200, text: 'two' },
      ],
    }];
    const first = normalizeAsrChunks(chunks);
    const second = normalizeAsrChunks(chunks);
    expect(first).toEqual(second);
    expect(first.map((s) => [s.startMs, s.endMs])).toEqual([[10_100, 10_700], [10_800, 11_200]]);
    expect(first[0].id).toBe(second[0].id);
  });

  it('rejects inverted ranges', () => {
    expect(() => normalizeAsrChunks([{ projectId: 'p1', chunkId: 'c1', offsetMs: 0, segments: [{ startMs: 5, endMs: 4, text: 'bad' }] }])).toThrow();
  });
});
