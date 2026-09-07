import { describe, expect, it } from 'vitest';
import { runDubbingPipeline } from '../src/workflows/pipeline';

describe('direct R2 Workers AI media contract', () => {
  it('propagates the signed source response media type into direct ASR', async () => {
    const asrContexts: Array<Record<string, unknown>> = [];
    const persisted = [{
      id: 'seg-a', projectId: 'project-1', speakerId: 'spk-a', startMs: 0, endMs: 1000,
      sourceText: 'hello', translatedText: '', translationEngine: 'workers-ai',
      translationContextRevision: null, translationStatus: 'pending', voiceStatus: 'pending',
      dubbedObjectKey: null, version: 1, splitParentId: null,
    }];
    const deps = {
      projects: {
        async getByIdForUser() {
          return { id: 'project-1', sourceObjectKey: 'projects/project-1/source/movie.mp4', sourceLanguage: 'en' as const };
        },
        async setStatus() {},
      },
      jobs: {
        async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
        async setProgress() {},
        async fail() {},
        async complete() {},
      },
      sourceMedia: {
        async prepareSource() {
          return {
            sourceId: 'projects/project-1/source/movie.mp4',
            durationMs: 12_000,
            audioUrl: 'https://yupvox.qs3d.site/api/media-source/project-1?signed=1',
          };
        },
      },
      fetcher: async () => new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '4' },
      }),
      asr: {
        async transcribe(_audio: ArrayBuffer, context: Record<string, unknown>) {
          asrContexts.push(context);
          return { text: 'hello', segments: [{ startMs: 0, endMs: 1000, text: 'hello' }] };
        },
      },
      asrProviderId: 'workers-ai-whisper-large-v3-turbo',
      segments: {
        async list() { return []; },
        async replaceFromAsr() { return persisted; },
        async setTranslationResult() { return null; },
      },
      translationContext: {
        async getContext() { return { revision: 1, style: 'neutral' as const, glossary: [] }; },
      },
      translationRouter: {
        async translate(_mode: unknown, items: Array<{ id: string; text: string }>) {
          return {
            mode: 'workers-ai' as const,
            primary: items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' })),
            contextRevision: null,
          };
        },
      },
      usage: { async record(input: unknown) { return input as never; } },
      telemetry: { write() {} },
    };
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

    await expect(runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      deps as any,
      step,
    )).resolves.toEqual({ status: 'needs_review', segmentCount: 1 });

    expect(asrContexts).toEqual([
      expect.objectContaining({ sourceLanguage: 'en', mediaType: 'video/mp4' }),
    ]);
  });
});
