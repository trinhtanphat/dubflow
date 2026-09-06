import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { WorkersAIAsrProvider } from '../src/services/asr/workers-ai';
import { DeepgramNova3AsrProvider } from '../src/services/asr/deepgram';
import { normalizeAsrChunks } from '../src/services/asr/normalize';
import { stitchAsrChunks } from '../src/services/asr/stitch';

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

describe('ASR cross-chunk stitching', () => {
  it('deduplicates a boundary utterance and carries one speaker identity into the next chunk', () => {
    const stitched = stitchAsrChunks([
      {
        projectId: 'p1', chunkId: 'c1', offsetMs: 0,
        segments: [{ startMs: 294_000, endMs: 296_000, text: ' Hello   World ', speakerIndex: 0 }],
      },
      {
        projectId: 'p1', chunkId: 'c2', offsetMs: 292_000,
        segments: [
          { startMs: 2_000, endMs: 4_000, text: 'hello world', speakerIndex: 3 },
          { startMs: 5_000, endMs: 6_000, text: 'later', speakerIndex: 3 },
        ],
      },
    ]);

    expect(stitched).toHaveLength(2);
    expect(stitched.map((segment) => segment.text)).toEqual([' Hello   World ', 'later']);
    expect(stitched[0].speakerId).toMatch(/^spk_[0-9a-f]{8}$/);
    expect(stitched[1].speakerId).toBe(stitched[0].speakerId);
  });

  it('keeps speaker identities separate when duplicate evidence is ambiguous', () => {
    const stitched = stitchAsrChunks([
      {
        projectId: 'p1', chunkId: 'c1', offsetMs: 0,
        segments: [
          { startMs: 294_000, endMs: 295_000, text: 'one', speakerIndex: 0 },
          { startMs: 296_000, endMs: 297_000, text: 'two', speakerIndex: 0 },
        ],
      },
      {
        projectId: 'p1', chunkId: 'c2', offsetMs: 292_000,
        segments: [
          { startMs: 2_000, endMs: 3_000, text: 'one', speakerIndex: 3 },
          { startMs: 4_000, endMs: 5_000, text: 'two', speakerIndex: 4 },
          { startMs: 6_000, endMs: 6_600, text: 'right three', speakerIndex: 3 },
          { startMs: 6_700, endMs: 7_300, text: 'right four', speakerIndex: 4 },
        ],
      },
    ]);

    expect(stitched).toHaveLength(4);
    const leftSpeaker = stitched.find((segment) => segment.text === 'one')?.speakerId;
    const rightThree = stitched.find((segment) => segment.text === 'right three')?.speakerId;
    const rightFour = stitched.find((segment) => segment.text === 'right four')?.speakerId;
    expect(leftSpeaker).toBeTruthy();
    expect(rightThree).toBeTruthy();
    expect(rightFour).toBeTruthy();
    expect(rightThree).not.toBe(leftSpeaker);
    expect(rightFour).not.toBe(leftSpeaker);
    expect(rightThree).not.toBe(rightFour);
  });

  it('deduplicates non-diarized overlap without inventing a speaker identity', () => {
    const stitched = stitchAsrChunks([
      {
        projectId: 'p1', chunkId: 'c1', offsetMs: 0,
        segments: [{ startMs: 294_000, endMs: 296_000, text: 'Same line' }],
      },
      {
        projectId: 'p1', chunkId: 'c2', offsetMs: 292_000,
        segments: [{ startMs: 2_050, endMs: 4_050, text: 'same line' }],
      },
    ]);

    expect(stitched).toHaveLength(1);
    expect(stitched[0].speakerId).toBeUndefined();
    expect(stitched[0].speakerIndex).toBeUndefined();
  });

  it('does not deduplicate equal text without temporal overlap', () => {
    const stitched = stitchAsrChunks([
      {
        projectId: 'p1', chunkId: 'c1', offsetMs: 0,
        segments: [{ startMs: 100_000, endMs: 101_000, text: 'yes', speakerIndex: 0 }],
      },
      {
        projectId: 'p1', chunkId: 'c2', offsetMs: 292_000,
        segments: [{ startMs: 2_000, endMs: 3_000, text: 'yes', speakerIndex: 0 }],
      },
    ]);

    expect(stitched).toHaveLength(2);
    expect(stitched[0].speakerId).not.toBe(stitched[1].speakerId);
  });
});
