import { describe, expect, it } from 'vitest';
import { runDubbingPipeline } from '../src/workflows/pipeline';

describe('dubbing workflow pipeline', () => {
  it('runs media -> bounded chunk ASR -> persist -> translate in order', async () => {
    const calls: string[] = [];
    const project = {
      id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
      targetLanguage: 'vi' as const, status: 'ready' as const, sourceObjectKey: 'projects/project-1/source/movie.mp4',
    };
    const persisted = [
      { id: 'seg-a', projectId: 'project-1', speakerId: null, startMs: 0, endMs: 1000, sourceText: '你好', translatedText: '', translationEngine: 'workers-ai', translationStatus: 'pending', voiceStatus: 'pending', version: 1 },
      { id: 'seg-b', projectId: 'project-1', speakerId: null, startMs: 300000, endMs: 301000, sourceText: '再见', translatedText: '', translationEngine: 'workers-ai', translationStatus: 'pending', voiceStatus: 'pending', version: 1 },
    ];
    const jobs = {
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
        const text = asrIndex++ === 0 ? '你好' : '再见';
        return { text, segments: [{ startMs: 0, endMs: 1000, text }] };
      },
    };
    const segments = {
      async replaceFromAsr() { calls.push('segments:replace'); return persisted; },
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
      { projects, jobs, media, bucket, asr, segments, translation },
      step,
    );

    expect(calls).toContain('project:processing');
    expect(calls.indexOf('r2:0')).toBeLessThan(calls.indexOf('asr:0'));
    expect(calls.indexOf('asr:0')).toBeLessThan(calls.indexOf('r2:1'));
    expect(calls.indexOf('r2:1')).toBeLessThan(calls.indexOf('asr:1'));
    expect(calls.indexOf('segments:replace')).toBeLessThan(calls.indexOf('translation:batch'));
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
    };

    await expect(runDubbingPipeline({ projectId: 'p', userId: 'u', jobId: 'j' }, deps, step)).rejects.toThrow('provider down');
    expect(calls).toContain('job:ASR_FAILED');
    expect(calls).toContain('project:failed');
  });
});
