import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { WorkersAIAsrProvider } from '../src/services/asr/workers-ai';
import { DeepgramNova3AsrProvider } from '../src/services/asr/deepgram';
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

describe('Deepgram Nova-3 diarized ASR', () => {
  it('requests batch diarization v2 and returns speaker-aware utterances', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({
        results: {
          channels: [{ alternatives: [{ transcript: '你好 世界' }] }],
          utterances: [
            { start: 0.25, end: 0.8, transcript: '你好', speaker: 0 },
            { start: 0.9, end: 1.45, transcript: '世界', speaker: 1 },
          ],
        },
      });
    };
    const provider = new DeepgramNova3AsrProvider('dg-secret', fetcher);
    const audio = new Uint8Array([1, 2, 3]).buffer;

    const result = await provider.transcribe(audio, { sourceLanguage: 'zh' });

    const request = calls[0];
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('diarize_model')).toBe('latest');
    expect(url.searchParams.get('utterances')).toBe('true');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('punctuate')).toBe('true');
    expect(url.searchParams.get('language')).toBe('zh');
    expect(request.init?.headers).toMatchObject({ Authorization: 'Token dg-secret', 'content-type': 'audio/wav' });
    expect(request.init?.body).toBe(audio);
    expect(result).toEqual({
      text: '你好 世界',
      segments: [
        { startMs: 250, endMs: 800, text: '你好', speakerIndex: 0 },
        { startMs: 900, endMs: 1450, text: '世界', speakerIndex: 1 },
      ],
    });
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

  it('preserves diarized speaker labels and creates a deterministic chunk-scoped speaker id', () => {
    const input = [{
      projectId: 'p1', chunkId: 'c9', offsetMs: 20_000,
      segments: [{ startMs: 100, endMs: 900, text: 'hello', speakerIndex: 2 }],
    }];
    const [segment] = normalizeAsrChunks(input);
    const [again] = normalizeAsrChunks(input);
    expect(segment).toMatchObject({
      startMs: 20_100,
      endMs: 20_900,
      speakerIndex: 2,
      chunkId: 'c9',
      speakerId: expect.stringMatching(/^spk_[0-9a-f]{8}$/),
    });
    expect(segment.speakerId).toBe(again.speakerId);
  });

  it('rejects inverted ranges', () => {
    expect(() => normalizeAsrChunks([{ projectId: 'p1', chunkId: 'c1', offsetMs: 0, segments: [{ startMs: 5, endMs: 4, text: 'bad' }] }])).toThrow();
  });
});
