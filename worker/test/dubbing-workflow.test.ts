import { describe, expect, it } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runDubbingPipeline } from '../src/workflows/pipeline';

const noUsage = { async record(input: UsageRecordInput) { return input as never; } };

describe('dubbing workflow pipeline', () => {
  it('runs media -> diarized bounded chunk ASR -> persist -> translate in order and meters real provider work', async () => {
    const calls: string[] = [];
    const usageEvents: UsageRecordInput[] = [];
    const project = {
      id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
      targetLanguage: 'vi' as const, status: 'ready' as const, sourceObjectKey: 'projects/project-1/source/movie.mp4',
    };
    const persisted = [
      { id: 'seg-a', projectId: 'project-1', speakerId: 'spk-a', startMs: 0, endMs: 1000, sourceText: '你好', translatedText: '', translationEngine: 'workers-ai', translationStatus: 'pending', voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null },
      { id: 'seg-b', projectId: 'project-1', speakerId: 'spk-b', startMs: 300000, endMs: 301000, sourceText: '再见', translatedText: '', translationEngine: 'workers-ai', translationStatus: 'pending', voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null },
    ];
    const jobs = {
      async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
      async setProgress(_id: string, _progress: number, stepName: string) { calls.push(`job:${stepName}`); },
      async fail() { calls.push('job:failed'); },
      async complete(_id: string, status?: string) { calls.push(`job:${status ?? 'completed'}`); },
    };
    const projects = {
      async getByIdForUser() { return project; },
      async setStatus(_id: string, _userId: string, status: string) { calls.push(`project:${status}`); },
    };
    const media = {
      async probe() { calls.push('media:probe'); return { durationMs: 360000 }; },
      async extractAudioChunks() {
        calls.push('media:chunks');
        return [
          { objectKey: 'projects/project-1/audio/000.wav', offsetMs: 0, durationMs: 300000 },
          { objectKey: 'projects/project-1/audio/001.wav', offsetMs: 300000, durationMs: 60000 },
        ];
      },
    };
    const bucket = {
      async get(key: string) {
        calls.push(`r2:${key.endsWith('000.wav') ? '0' : '1'}`);
        return { key, size: 3, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }) };
      },
    };
    let asrIndex = 0;
    const asr = {
      async transcribe() {
        calls.push(`asr:${asrIndex}`);
        const current = asrIndex++;
        const text = current === 0 ? '你好' : '再见';
        return { text, segments: [{ startMs: 0, endMs: 1000, text, speakerIndex: current }] };
      },
    };
    let persistedAsrInput: Array<{ id: string; speakerId?: string | null; startMs: number; endMs: number; sourceText: string }> = [];
    const segments = {
      async replaceFromAsr(_projectId: string, _userId: string, input: typeof persistedAsrInput) {
        calls.push('segments:replace');
        persistedAsrInput = input;
        return persisted;
      },
      async setTranslationResult(_p: string, id: string) { calls.push(`segments:translate:${id}`); return null; },
    };
    const translation = {
      async translateBatch(items: { id: string; text: string }[]) {
        calls.push('translation:batch');
        return items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' }));
      },
    };
    const usage = { async record(input: UsageRecordInput) { usageEvents.push(input); return input as never; } };
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };
    const deps = {
      projects, jobs, media, bucket, asr, segments, translation, usage,
      asrProviderId: 'deepgram-nova-3',
      translationProviderId: 'workers-ai',
    };

    await runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      deps,
      step,
    );

    expect(calls).toContain('project:processing');
    expect(calls.indexOf('r2:0')).toBeLessThan(calls.indexOf('asr:0'));
    expect(calls.indexOf('asr:0')).toBeLessThan(calls.indexOf('r2:1'));
    expect(calls.indexOf('r2:1')).toBeLessThan(calls.indexOf('asr:1'));
    expect(calls.indexOf('segments:replace')).toBeLessThan(calls.indexOf('translation:batch'));
    expect(persistedAsrInput).toHaveLength(2);
    expect(persistedAsrInput[0].speakerId).toMatch(/^spk_[0-9a-f]{8}$/);
    expect(persistedAsrInput[1].speakerId).toMatch(/^spk_[0-9a-f]{8}$/);
    expect(persistedAsrInput[0].speakerId).not.toBe(persistedAsrInput[1].speakerId);
    expect(calls).toContain('project:needs_review');
    expect(calls).toContain('job:needs_review');

    expect(usageEvents).toEqual([
      expect.objectContaining({ kind: 'asr_audio_minute', units: 5, provider: 'deepgram-nova-3', phase: 'started', operationKey: 'job:job-1:retry:0:asr:projects/project-1/audio/000.wav:deepgram-nova-3' }),
      expect.objectContaining({ kind: 'asr_audio_minute', units: 5, provider: 'deepgram-nova-3', phase: 'completed', operationKey: 'job:job-1:retry:0:asr:projects/project-1/audio/000.wav:deepgram-nova-3' }),
      expect.objectContaining({ kind: 'asr_audio_minute', units: 1, provider: 'deepgram-nova-3', phase: 'started', operationKey: 'job:job-1:retry:0:asr:projects/project-1/audio/001.wav:deepgram-nova-3' }),
      expect.objectContaining({ kind: 'asr_audio_minute', units: 1, provider: 'deepgram-nova-3', phase: 'completed', operationKey: 'job:job-1:retry:0:asr:projects/project-1/audio/001.wav:deepgram-nova-3' }),
      expect.objectContaining({ kind: 'translation_character', units: 4, provider: 'workers-ai', phase: 'started', operationKey: 'job:job-1:retry:0:translation:batch-0:workers-ai' }),
      expect.objectContaining({ kind: 'translation_character', units: 4, provider: 'workers-ai', phase: 'completed', operationKey: 'job:job-1:retry:0:translation:batch-0:workers-ai' }),
    ]);
  });

  it('uses the durable retry generation in usage operation keys', async () => {
    async function asrKey(retryCount: number) {
      const events: UsageRecordInput[] = [];
      const deps = {
        projects: {
          async getByIdForUser() { return { id: 'p', sourceObjectKey: 'projects/p/source/x.mp4', sourceLanguage: 'zh' as const }; },
          async setStatus() {},
        },
        jobs: {
          async getForProject() { return { status: 'running' as const, retryCount }; },
          async setProgress() {}, async fail() {}, async complete() {},
        },
        media: {
          async probe() { return { durationMs: 60000 }; },
          async extractAudioChunks() { return [{ objectKey: 'projects/p/audio/000.wav', offsetMs: 0, durationMs: 60000 }]; },
        },
        bucket: { async get(key: string) { return { key, size: 1, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) }; } },
        asr: { async transcribe() { return { text: '', segments: [] }; } },
        segments: { async replaceFromAsr() { return []; }, async setTranslationResult() { return null; } },
        translation: { async translateBatch() { return []; } },
        usage: { async record(input: UsageRecordInput) { events.push(input); return input as never; } },
        asrProviderId: 'workers-ai-whisper-large-v3-turbo',
        translationProviderId: 'workers-ai',
      };
      const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };
      await runDubbingPipeline({ projectId: 'p', userId: 'u', jobId: 'j' }, deps, step);
      return events.find((event) => event.kind === 'asr_audio_minute' && event.phase === 'started')?.operationKey;
    }

    expect(await asrKey(0)).toBe('job:j:retry:0:asr:projects/p/audio/000.wav:workers-ai-whisper-large-v3-turbo');
    expect(await asrKey(1)).toBe('job:j:retry:1:asr:projects/p/audio/000.wav:workers-ai-whisper-large-v3-turbo');
  });

  it('persists a stable ASR failure before rethrowing', async () => {
    const calls: string[] = [];
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };
    const deps = {
      projects: {
        async getByIdForUser() { return { id: 'p', userId: 'u', title: 'x', sourceLanguage: 'zh' as const, targetLanguage: 'vi' as const, status: 'ready' as const, sourceObjectKey: 'projects/p/source/x.mp4' }; },
        async setStatus(_id: string, _userId: string, status: string) { calls.push(`project:${status}`); },
      },
      jobs: {
        async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
        async setProgress() {},
        async fail(_id: string, code: string) { calls.push(`job:${code}`); },
        async complete() {},
      },
      media: {
        async probe() { return { durationMs: 1000 }; },
        async extractAudioChunks() { return [{ objectKey: 'projects/p/audio/000.wav', offsetMs: 0, durationMs: 1000 }]; },
      },
      bucket: {
        async get(key: string) { return { key, size: 1, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }) }; },
      },
      asr: { async transcribe() { throw new Error('provider down'); } },
      segments: { async replaceFromAsr() { return []; }, async setTranslationResult() { return null; } },
      translation: { async translateBatch() { return []; } },
      usage: noUsage,
      asrProviderId: 'deepgram-nova-3',
      translationProviderId: 'workers-ai',
    };

    await expect(runDubbingPipeline({ projectId: 'p', userId: 'u', jobId: 'j' }, deps, step)).rejects.toThrow('provider down');
    expect(calls).toContain('job:ASR_FAILED');
    expect(calls).toContain('project:failed');
  });

  it('stops before the next expensive ASR boundary when the durable job is cancelled', async () => {
    const calls: string[] = [];
    let checks = 0;
    const deps = {
      projects: {
        async getByIdForUser() { return { id: 'p', sourceObjectKey: 'projects/p/source/x.mp4', sourceLanguage: 'zh' as const }; },
        async setStatus(_id: string, _userId: string, status: string) { calls.push(`project:${status}`); },
      },
      jobs: {
        async getForProject() {
          checks += 1;
          return { status: checks >= 3 ? 'cancelled' as const : 'running' as const, retryCount: 0 };
        },
        async setProgress() {},
        async fail() { calls.push('job:failed'); },
        async complete() { calls.push('job:complete'); },
      },
      media: {
        async probe() { calls.push('media:probe'); return { durationMs: 1000 }; },
        async extractAudioChunks() {
          calls.push('media:chunks');
          return [{ objectKey: 'projects/p/audio/000.wav', offsetMs: 0, durationMs: 1000 }];
        },
      },
      bucket: { async get() { calls.push('bucket:get'); return { key: 'x', size: 1, body: new ReadableStream<Uint8Array>() }; } },
      asr: { async transcribe() { calls.push('asr:called'); return { text: 'x', segments: [] }; } },
      segments: { async replaceFromAsr() { return []; }, async setTranslationResult() { return null; } },
      translation: { async translateBatch() { return []; } },
      usage: noUsage,
      asrProviderId: 'workers-ai-whisper-large-v3-turbo',
      translationProviderId: 'workers-ai',
    };
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

    await expect(runDubbingPipeline({ projectId: 'p', userId: 'u', jobId: 'j' }, deps, step))
      .rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    expect(calls).not.toContain('asr:called');
    expect(calls).not.toContain('job:failed');
    expect(calls).toContain('project:cancelled');
  });
});
