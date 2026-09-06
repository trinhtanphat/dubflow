import { describe, expect, it } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runDubbingPipeline } from '../src/workflows/pipeline';

describe('Phase 4A workflow stitching', () => {
  it('persists one overlap utterance, stitches its speaker, and meters all provider-processed seconds', async () => {
    const usageEvents: UsageRecordInput[] = [];
    let asrIndex = 0;
    let persistedInput: Array<{ id: string; speakerId?: string | null; startMs: number; endMs: number; sourceText: string }> = [];

    const deps = {
      projects: {
        async getByIdForUser() {
          return { id: 'p1', sourceObjectKey: 'projects/p1/source/movie.mp4', sourceLanguage: 'zh' as const };
        },
        async setStatus() {},
      },
      jobs: {
        async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
        async setProgress() {},
        async fail() {},
        async complete() {},
      },
      media: {
        async probe() { return { durationMs: 360_000 }; },
        async extractAudioChunks() {
          return [
            { objectKey: 'projects/p1/audio/000.wav', offsetMs: 0, durationMs: 300_000 },
            { objectKey: 'projects/p1/audio/001.wav', offsetMs: 292_000, durationMs: 68_000 },
          ];
        },
      },
      bucket: {
        async get(key: string) {
          return {
            key,
            size: 1,
            body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }),
          };
        },
      },
      asr: {
        async transcribe() {
          const index = asrIndex++;
          if (index === 0) {
            return {
              text: 'boundary',
              segments: [{ startMs: 294_000, endMs: 296_000, text: 'Boundary line', speakerIndex: 0 }],
            };
          }
          return {
            text: 'boundary later',
            segments: [
              { startMs: 2_050, endMs: 4_050, text: 'boundary line', speakerIndex: 3 },
              { startMs: 5_000, endMs: 6_000, text: 'later', speakerIndex: 3 },
            ],
          };
        },
      },
      segments: {
        async replaceFromAsr(_projectId: string, _userId: string, input: typeof persistedInput) {
          persistedInput = input;
          return input.map((segment) => ({
            ...segment,
            projectId: 'p1',
            translatedText: '',
            translationEngine: 'workers-ai' as const,
            translationStatus: 'pending' as const,
            voiceStatus: 'pending' as const,
            dubbedObjectKey: null,
            version: 1,
            splitParentId: null,
          }));
        },
        async setTranslationResult() { return null; },
      },
      translation: {
        async translateBatch(items: { id: string; text: string }[]) {
          return items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' }));
        },
      },
      usage: {
        async record(input: UsageRecordInput) { usageEvents.push(input); return input as never; },
      },
      telemetry: { write() {} },
      asrProviderId: 'deepgram-nova-3',
      translationProviderId: 'workers-ai',
    };
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

    await runDubbingPipeline({ projectId: 'p1', userId: 'u1', jobId: 'j1' }, deps, step);

    expect(persistedInput).toHaveLength(2);
    expect(persistedInput.map((segment) => segment.sourceText)).toEqual(['Boundary line', 'later']);
    expect(persistedInput[0].speakerId).toMatch(/^spk_[0-9a-f]{8}$/);
    expect(persistedInput[1].speakerId).toBe(persistedInput[0].speakerId);

    expect(usageEvents
      .filter((event) => event.kind === 'asr_audio_second' && event.phase === 'completed')
      .map((event) => event.units))
      .toEqual([300, 68]);
  });
});
