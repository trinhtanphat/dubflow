import { describe, expect, it } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runDubbingPipeline } from '../src/workflows/pipeline';

type PersistInput = Array<{ id: string; speakerId?: string | null; startMs: number; endMs: number; sourceText: string }>;

type ExistingSegment = {
  id: string;
  projectId: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
  translationEngine: string;
  translationStatus: string;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
  splitParentId: string | null;
};

function makeDeps(existing: ExistingSegment[] = []) {
  const calls: string[] = [];
  const usage: UsageRecordInput[] = [];
  let replaceInput: PersistInput = [];
  let asrIndex = 0;

  const deps = {
    projects: {
      async getByIdForUser() {
        return { id: 'p1', sourceObjectKey: 'projects/p1/source/video.mp4', sourceLanguage: 'en' as const };
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
          {
            objectKey: 'projects/p1/audio/00000.wav',
            offsetMs: 0,
            durationMs: 300_000,
            overlapBeforeMs: 0,
            overlapAfterMs: 15_000,
          },
          {
            objectKey: 'projects/p1/audio/00001.wav',
            offsetMs: 285_000,
            durationMs: 75_000,
            overlapBeforeMs: 15_000,
            overlapAfterMs: 0,
          },
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
        calls.push(`asr:${asrIndex}`);
        const result = asrIndex === 0
          ? {
              text: 'before shared',
              segments: [
                { startMs: 270_000, endMs: 272_000, text: 'before', speakerIndex: 0 },
                { startMs: 290_000, endMs: 295_000, text: 'Shared!', speakerIndex: 0 },
              ],
            }
          : {
              text: 'shared after',
              segments: [
                { startMs: 5_000, endMs: 10_000, text: 'shared', speakerIndex: 2 },
                { startMs: 20_000, endMs: 22_000, text: 'after', speakerIndex: 2 },
              ],
            };
        asrIndex += 1;
        return result;
      },
    },
    asrProviderId: 'deepgram-nova-3',
    segments: {
      async list() {
        calls.push('segments:list');
        return existing;
      },
      async replaceFromAsr(_projectId: string, _userId: string, input: PersistInput) {
        calls.push('segments:replace');
        replaceInput = input;
        return input.map((segment) => ({
          id: segment.id,
          projectId: 'p1',
          speakerId: segment.speakerId ?? null,
          startMs: segment.startMs,
          endMs: segment.endMs,
          sourceText: segment.sourceText,
          translatedText: '',
          translationEngine: 'workers-ai',
          translationStatus: 'pending',
          voiceStatus: 'pending',
          dubbedObjectKey: null,
          version: 1,
          splitParentId: null,
        }));
      },
      async setTranslationResult() { return null; },
    },
    translation: {
      async translateBatch(items: Array<{ id: string; text: string }>) {
        return items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' }));
      },
    },
    translationProviderId: 'workers-ai',
    usage: {
      async record(input: UsageRecordInput) { usage.push(input); return input as never; },
    },
    telemetry: { write() {} },
  };

  return { deps, calls, usage, getReplaceInput: () => replaceInput };
}

const step = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };

describe('Phase 4A project-stable diarization pipeline integration', () => {
  it('finishes all ASR work before history load, dedupes overlap, and stitches one speaker', async () => {
    const fixture = makeDeps();

    await runDubbingPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, fixture.deps, step);

    expect(fixture.calls.indexOf('asr:1')).toBeLessThan(fixture.calls.indexOf('segments:list'));
    expect(fixture.calls.indexOf('segments:list')).toBeLessThan(fixture.calls.indexOf('segments:replace'));
    const persisted = fixture.getReplaceInput();
    expect(persisted.map((segment) => segment.sourceText)).toEqual(['before', 'Shared!', 'after']);
    expect(new Set(persisted.map((segment) => segment.speakerId))).toHaveLength(1);
    expect(persisted[0].speakerId).toMatch(/^spk_[0-9a-f]{8}$/);

    expect(fixture.usage.filter((event) => event.kind === 'asr_audio_second' && event.phase === 'completed')
      .map((event) => event.units)).toEqual([300, 75]);
  });

  it('reuses one unambiguous historical speaker id before replacement', async () => {
    const fixture = makeDeps([{
      id: 'old-segment',
      projectId: 'p1',
      speakerId: 'spk_existing',
      startMs: 269_000,
      endMs: 308_000,
      sourceText: 'old transcript',
      translatedText: 'old translation',
      translationEngine: 'workers-ai',
      translationStatus: 'completed',
      voiceStatus: 'completed',
      dubbedObjectKey: 'projects/p1/dubbed/old.mp3',
      version: 4,
      splitParentId: null,
    }]);

    await runDubbingPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, fixture.deps, step);

    const persisted = fixture.getReplaceInput();
    expect(persisted).toHaveLength(3);
    expect(new Set(persisted.map((segment) => segment.speakerId))).toEqual(new Set(['spk_existing']));
  });
});
