import { describe, expect, it } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runDubbingPipeline } from '../src/workflows/pipeline';

const neutralContext = { revision: 1, style: 'neutral' as const, glossary: [] };
const noTelemetry = { write() {} };

function baseDeps(calls: string[], usageEvents: UsageRecordInput[]) {
  const project = {
    id: 'project-1', sourceObjectKey: 'projects/project-1/source/movie.mp4', sourceLanguage: 'en' as const,
  };
  const persisted = [{
    id: 'seg-a', projectId: 'project-1', speakerId: 'spk-a', startMs: 0, endMs: 1500,
    sourceText: 'hello world', translatedText: '', translationEngine: 'workers-ai',
    translationContextRevision: null, translationStatus: 'pending', voiceStatus: 'pending',
    dubbedObjectKey: null, version: 1, splitParentId: null,
  }];
  return {
    projects: {
      async getByIdForUser() { return project; },
      async setStatus(_id: string, _userId: string, status: string) { calls.push(`project:${status}`); },
    },
    jobs: {
      async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
      async setProgress(_id: string, _progress: number, stage: string) { calls.push(`job:${stage}`); },
      async fail(_id: string, code: string) { calls.push(`job:failed:${code}`); },
      async complete(_id: string, status?: string) { calls.push(`job:${status ?? 'completed'}`); },
    },
    sourceMedia: {
      async prepareSource(projectId: string, userId: string, key: string) {
        calls.push(`stream:${projectId}:${userId}:${key}`);
        return { sourceId: 'stream-1', durationMs: 12_500, audioUrl: 'https://videodelivery.net/audio.m4a' };
      },
    },
    segments: {
      async list() { return []; },
      async replaceFromAsr(_projectId: string, _userId: string, input: unknown[]) {
        calls.push(`segments:replace:${input.length}`);
        return persisted;
      },
      async setTranslationResult() { calls.push('segments:translated'); return null; },
    },
    translationContext: { async getContext() { return neutralContext; } },
    translationRouter: {
      async translate(_mode: unknown, items: Array<{ id: string; text: string }>) {
        calls.push('translation:batch');
        return {
          mode: 'workers-ai' as const,
          primary: items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' })),
          contextRevision: null,
        };
      },
    },
    usage: {
      async record(input: UsageRecordInput) { usageEvents.push(input); return input as never; },
    },
    telemetry: noTelemetry,
    asrProviderId: 'deepgram-nova-3',
  };
}

describe('zero-container dubbing pipeline', () => {
  it('uses Stream audio and remote Deepgram ASR without media chunks or R2 audio buffering', async () => {
    const calls: string[] = [];
    const usageEvents: UsageRecordInput[] = [];
    const deps = {
      ...baseDeps(calls, usageEvents),
      asr: {
        async transcribeUrl(url: string) {
          calls.push(`asr:remote:${url}`);
          return {
            text: 'hello world',
            segments: [{ startMs: 0, endMs: 1500, text: 'hello world', speakerIndex: 0 }],
          };
        },
      },
    };
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

    await expect(runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      deps as any,
      step,
    )).resolves.toEqual({ status: 'needs_review', segmentCount: 1 });

    expect(calls).toContain('job:stream_ingest');
    expect(calls).toContain('asr:remote:https://videodelivery.net/audio.m4a');
    expect(calls.find((call) => call.startsWith('segments:replace:'))).toBe('segments:replace:1');
    expect(calls.indexOf('asr:remote:https://videodelivery.net/audio.m4a')).toBeLessThan(calls.indexOf('translation:batch'));
    expect(usageEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'asr_audio_second', units: 12.5, provider: 'deepgram-nova-3', phase: 'started',
        operationKey: 'job:job-1:retry:0:asr:stream:stream-1:deepgram-nova-3',
      }),
      expect.objectContaining({
        kind: 'asr_audio_second', units: 12.5, provider: 'deepgram-nova-3', phase: 'completed',
        operationKey: 'job:job-1:retry:0:asr:stream:stream-1:deepgram-nova-3',
      }),
    ]));
  });

  it('fails explicitly when long-form Stream audio has no remote-capable ASR provider', async () => {
    const calls: string[] = [];
    const usageEvents: UsageRecordInput[] = [];
    const deps = {
      ...baseDeps(calls, usageEvents),
      sourceMedia: {
        async prepareSource() {
          return { sourceId: 'stream-long', durationMs: 3_600_000, audioUrl: 'https://videodelivery.net/long-audio.m4a' };
        },
      },
      asr: { async transcribe() { throw new Error('must not buffer long-form media'); } },
      asrProviderId: 'workers-ai-whisper-large-v3-turbo',
    };
    const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

    await expect(runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      deps as any,
      step,
    )).rejects.toThrow(/ASR_LONG_FORM_UNAVAILABLE/);
    expect(calls).toContain('job:failed:ASR_LONG_FORM_UNAVAILABLE');
  });
});
