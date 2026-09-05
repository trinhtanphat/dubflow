import { describe, expect, it } from 'vitest';
import type { UsageStore } from '../src/db/usage';
import { runDubbingPipeline } from '../src/workflows/pipeline';

const noOpUsage: Pick<UsageStore, 'record'> = {
  async record(input) {
    return {
      inserted: true,
      event: {
        id: `usage-${input.kind}`,
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        kind: input.kind,
        units: input.units,
        provider: input.provider,
        creditRate: 0,
        credits: 0,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: '2026-09-05T17:27:00Z',
      },
    };
  },
};

describe('dubbing workflow pipeline', () => {
  it('runs media -> diarized bounded chunk ASR -> persist -> translate in order', async () => {
    const calls: string[] = [];
    const project = {
      id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
      targetLanguage: 'vi' as const, status: 'ready' as const, sourceObjectKey: 'projects/project-1/source/movie.mp4',
    };
    const persisted = [
      { id: 'seg-a', projectId: 'project-1', speakerId: 'spk-a', startMs: 0, endMs: 1000, sourceText: '你好', translatedText: '', translationEngine: 'workers-ai', translationStatus: 'pending', voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null },
      { id: 'seg-b', projectId: 'project-1', speakerId: 'spk-b', startMs: 300000, endMs: 301000, sourceText: '再见', translatedText: '', translationEngine: 'workers-ai', translationStatus: 'pending', voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null },
    ];
    const jobs = {
      async getForProject() { return { status: 'running' as const }; },
      async setProgress(_id: string, _progress: number, step: string) { calls.push(`job:${step}`); },
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
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

    await runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      { projects, jobs, media, bucket, asr, asrProvider: 'deepgram-nova-3', segments, translation, usage: noOpUsage },
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
        async getForProject() { return { status: 'running' as const }; },
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
      asrProvider: 'deepgram-nova-3',
      segments: { async replaceFromAsr() { return []; }, async setTranslationResult() { return null; } },
      translation: { async translateBatch() { return []; } },
      usage: noOpUsage,
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
          return { status: checks >= 3 ? 'cancelled' as const : 'running' as const };
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
      asrProvider: 'deepgram-nova-3',
      segments: { async replaceFromAsr() { return []; }, async setTranslationResult() { return null; } },
      translation: { async translateBatch() { return []; } },
      usage: noOpUsage,
    };
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

    await expect(runDubbingPipeline({ projectId: 'p', userId: 'u', jobId: 'j' }, deps, step))
      .rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    expect(calls).not.toContain('asr:called');
    expect(calls).not.toContain('job:failed');
    expect(calls).toContain('project:cancelled');
  });
});
