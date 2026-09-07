import { describe, expect, it } from 'vitest';
import { runDubbingPipeline } from '../src/workflows/pipeline';

const neutralContext = { revision: 1, style: 'neutral' as const, glossary: [] };
const noTelemetry = { write() {} };

function depsFor(input: { preparedDuration: number | null; asrDuration?: number }) {
  const progressStages: string[] = [];
  const stepNames: string[] = [];
  const projectDurationWrites: number[] = [];
  const remoteUrls: string[] = [];
  const persisted = [{
    id: 'seg-a', projectId: 'project-1', speakerId: 'spk-a', startMs: 0, endMs: 1_500,
    sourceText: 'hello', translatedText: '', translationEngine: 'workers-ai',
    translationContextRevision: null, translationStatus: 'pending', voiceStatus: 'pending',
    dubbedObjectKey: null, version: 1, splitParentId: null,
  }];
  return {
    progressStages,
    stepNames,
    projectDurationWrites,
    remoteUrls,
    deps: {
      projects: {
        async getByIdForUser() {
          return { id: 'project-1', sourceObjectKey: 'projects/project-1/source/movie.mp4', sourceLanguage: 'en' as const };
        },
        async setStatus(_id: string, _userId: string, _status: string, durationMs?: number) {
          if (typeof durationMs === 'number') projectDurationWrites.push(durationMs);
        },
      },
      jobs: {
        async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
        async setProgress(_id: string, _progress: number, stage: string) { progressStages.push(stage); },
        async fail() {},
        async complete() {},
      },
      sourceMedia: {
        async prepareSource() {
          return {
            sourceId: 'projects/project-1/source/movie.mp4',
            durationMs: input.preparedDuration,
            audioUrl: 'https://yupvox.qs3d.site/api/media-source/project-1?signed=1',
          };
        },
      },
      asr: {
        async transcribeUrl(url: string) {
          remoteUrls.push(url);
          return {
            text: 'hello',
            durationMs: input.asrDuration,
            segments: [{ startMs: 0, endMs: 1_500, text: 'hello', speakerIndex: 0 }],
          };
        },
      },
      asrProviderId: 'deepgram-nova-3',
      segments: {
        async list() { return []; },
        async replaceFromAsr() { return persisted; },
        async setTranslationResult() { return null; },
      },
      translationContext: { async getContext() { return neutralContext; } },
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
      telemetry: noTelemetry,
    },
    step: {
      async do<T>(name: string, fn: () => Promise<T>) {
        stepNames.push(name);
        return fn();
      },
    },
  };
}

describe('zero-Stream dubbing pipeline', () => {
  it('sends the signed R2 source URL directly to remote ASR and uses provider duration', async () => {
    const fixture = depsFor({ preparedDuration: null, asrDuration: 90_000 });
    await expect(runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      fixture.deps as never,
      fixture.step,
    )).resolves.toEqual({ status: 'needs_review', segmentCount: 1 });

    expect(fixture.remoteUrls).toEqual(['https://yupvox.qs3d.site/api/media-source/project-1?signed=1']);
    expect(fixture.progressStages).not.toContain('stream_ingest');
    expect(fixture.stepNames.join(' ')).not.toMatch(/Stream/i);
    expect(fixture.projectDurationWrites).toContain(90_000);
  });

  it('fails closed when neither the stored source nor remote ASR reports a valid duration', async () => {
    const fixture = depsFor({ preparedDuration: null });
    await expect(runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      fixture.deps as never,
      fixture.step,
    )).rejects.toThrow(/duration/i);
  });
});
