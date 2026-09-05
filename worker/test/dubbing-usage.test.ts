import { describe, expect, it } from 'vitest';
import type { UsageStore } from '../src/db/usage';
import type { RecordUsageInput } from '../src/domain/usage';
import { runDubbingPipeline } from '../src/workflows/pipeline';

function successfulDeps(records: RecordUsageInput[]) {
  const persisted = [{
    id: 'seg-1', projectId: 'p1', speakerId: 'spk-1', startMs: 0, endMs: 1000,
    sourceText: '你好', translatedText: '', translationEngine: 'workers-ai',
    translationStatus: 'pending', voiceStatus: 'pending', dubbedObjectKey: null,
    version: 1, splitParentId: null,
  }];
  const usage: Pick<UsageStore, 'record'> = {
    async record(input) {
      records.push(input);
      return {
        inserted: true,
        event: {
          id: `usage-${records.length}`,
          userId: input.userId,
          projectId: input.projectId,
          jobId: input.jobId,
          kind: input.kind,
          units: input.units,
          provider: input.provider,
          creditRate: 1,
          credits: 1,
          idempotencyKey: input.idempotencyKey ?? null,
          createdAt: '2026-09-05T17:15:00Z',
        },
      };
    },
  };
  return {
    projects: {
      async getByIdForUser() { return { id: 'p1', sourceObjectKey: 'projects/p1/source/movie.mp4', sourceLanguage: 'zh' as const }; },
      async setStatus() {},
    },
    jobs: {
      async getForProject() { return { status: 'running' as const }; },
      async setProgress() {},
      async fail() {},
      async complete() {},
    },
    media: {
      async probe() { return { durationMs: 6000 }; },
      async extractAudioChunks() { return [{ objectKey: 'projects/p1/audio/000.wav', offsetMs: 0, durationMs: 6000 }]; },
    },
    bucket: {
      async get(key: string) {
        return { key, size: 1, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) };
      },
    },
    asr: {
      async transcribe() { return { text: '你好', segments: [{ startMs: 0, endMs: 1000, text: '你好', speakerIndex: 0 }] }; },
    },
    segments: {
      async replaceFromAsr() { return persisted; },
      async setTranslationResult() { return null; },
    },
    translation: {
      async translateBatch(items: Array<{ id: string; text: string }>) {
        return items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' as const }));
      },
    },
    usage,
    asrProvider: 'deepgram-nova-3',
  };
}

const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

describe('Phase 3B dubbing usage metering', () => {
  it('records successful ASR seconds and translation characters with stable attempt keys', async () => {
    const records: RecordUsageInput[] = [];
    const deps = successfulDeps(records) as Parameters<typeof runDubbingPipeline>[1] & {
      usage: Pick<UsageStore, 'record'>;
      asrProvider: string;
    };

    await runDubbingPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1', usageAttempt: 3 },
      deps,
      step,
    );

    expect(records).toEqual([
      {
        userId: 'dev-user', projectId: 'p1', jobId: 'j1',
        kind: 'asr_audio_seconds', units: 6, provider: 'deepgram-nova-3',
        idempotencyKey: 'job:j1:attempt:3:asr:projects/p1/audio/000.wav',
      },
      {
        userId: 'dev-user', projectId: 'p1', jobId: 'j1',
        kind: 'translation_characters', units: 2, provider: 'workers-ai',
        idempotencyKey: 'job:j1:attempt:3:translation:0',
      },
    ]);
  });

  it('uses attempt zero when the initial workflow omits usageAttempt', async () => {
    const records: RecordUsageInput[] = [];
    const deps = successfulDeps(records) as Parameters<typeof runDubbingPipeline>[1] & {
      usage: Pick<UsageStore, 'record'>;
      asrProvider: string;
    };

    await runDubbingPipeline({ projectId: 'p1', userId: 'dev-user', jobId: 'j1' }, deps, step);

    expect(records.map((event) => event.idempotencyKey)).toEqual([
      'job:j1:attempt:0:asr:projects/p1/audio/000.wav',
      'job:j1:attempt:0:translation:0',
    ]);
  });

  it('does not record usage when ASR fails before a successful provider result', async () => {
    const records: RecordUsageInput[] = [];
    const deps = successfulDeps(records) as Parameters<typeof runDubbingPipeline>[1] & {
      usage: Pick<UsageStore, 'record'>;
      asrProvider: string;
    };
    deps.asr = { async transcribe() { throw new Error('provider down'); } };

    await expect(runDubbingPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1', usageAttempt: 1 },
      deps,
      step,
    )).rejects.toThrow('provider down');

    expect(records).toEqual([]);
  });
});
