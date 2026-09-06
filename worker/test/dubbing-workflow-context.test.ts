import { describe, expect, it } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runDubbingPipeline } from '../src/workflows/pipeline';

function persistedSegment(index: number, sourceText: string) {
  return {
    id: `seg-${index}`,
    projectId: 'project-1',
    speakerId: 'spk-1',
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    sourceText,
    translatedText: '',
    translationEngine: 'workers-ai',
    translationContextRevision: null,
    translationStatus: 'pending',
    voiceStatus: 'pending',
    dubbedObjectKey: null,
    version: 1,
    splitParentId: null,
  };
}

function sourceSegments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: index === 0 ? 'A😀' : 'x',
    speakerIndex: 0,
  }));
}

const step = { async do<T>(_name: string, fn: () => Promise<T>) { return fn(); } };

function baseInfra(persisted: ReturnType<typeof persistedSegment>[], usageEvents: UsageRecordInput[]) {
  return {
    projects: {
      async getByIdForUser() {
        return {
          id: 'project-1',
          sourceObjectKey: 'projects/project-1/source/video.mp4',
          sourceLanguage: 'en' as const,
        };
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
      async probe() { return { durationMs: Math.max(1000, persisted.length * 1000) }; },
      async extractAudioChunks() {
        return [{
          objectKey: 'projects/project-1/audio/000.wav',
          offsetMs: 0,
          durationMs: Math.max(1000, persisted.length * 1000),
          overlapBeforeMs: 0,
          overlapAfterMs: 0,
        }];
      },
    },
    bucket: {
      async get(key: string) {
        return {
          key,
          size: 1,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
        };
      },
    },
    asr: {
      async transcribe() {
        return { text: '', segments: sourceSegments(persisted.length) };
      },
    },
    asrProviderId: 'workers-ai-whisper-large-v3-turbo',
    usage: {
      async record(input: UsageRecordInput) {
        usageEvents.push(input);
        return input as never;
      },
    },
    telemetry: { write() {} },
  };
}

describe('dubbing workflow translation context snapshot', () => {
  it('loads one active Vietnamese context snapshot for two batches and preserves contextual provenance plus accounting', async () => {
    const persisted = Array.from({ length: 26 }, (_, index) =>
      persistedSegment(index, index === 0 ? 'A😀' : 'x'));
    const usageEvents: UsageRecordInput[] = [];
    const persistedTranslations: Array<{ id: string; engine: string; contextRevision: number | null | undefined }> = [];
    const routerContexts: unknown[] = [];
    const routerModes: unknown[] = [];
    const contextTargets: unknown[] = [];
    let contextLoads = 0;

    const context = {
      revision: 7,
      style: 'natural' as const,
      glossary: [],
    };

    const infra = baseInfra(persisted, usageEvents);
    const deps = {
      ...infra,
      segments: {
        async list() { return []; },
        async replaceFromAsr() { return persisted; },
        async setTranslationResult(
          _projectId: string,
          id: string,
          _userId: string,
          _expectedVersion: number,
          _translatedText: string,
          engine: 'workers-ai' | 'google',
          contextRevision?: number | null,
        ) {
          persistedTranslations.push({ id, engine, contextRevision });
          return persisted.find((segment) => segment.id === id) ?? null;
        },
      },
      translationContext: {
        async getContext(_projectId: string, _userId: string, targetLanguage?: string) {
          contextLoads += 1;
          contextTargets.push(targetLanguage);
          return context;
        },
      },
      translationRouter: {
        async translate(mode: unknown, items: Array<{ id: string; text: string }>, _source: string, _target: 'vi', receivedContext: unknown) {
          routerModes.push(mode);
          routerContexts.push(receivedContext);
          return {
            mode: 'contextual' as const,
            primary: items.map((item) => ({
              id: item.id,
              text: `vi:${item.text}`,
              provider: 'workers-ai-contextual',
            })),
            contextRevision: 7,
          };
        },
      },
      translation: {
        capabilities: { contextual: false, available: true },
        async translateBatch() {
          throw new Error('legacy direct translation provider used');
        },
      },
      translationProviderId: 'workers-ai',
    };

    await expect(runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' },
      deps,
      step,
    )).resolves.toEqual({ status: 'needs_review', segmentCount: 26 });

    expect(contextLoads).toBe(1);
    expect(contextTargets).toEqual(['vi']);
    expect(routerModes).toEqual([undefined, undefined]);
    expect(routerContexts).toHaveLength(2);
    expect(routerContexts[0]).toBe(context);
    expect(routerContexts[1]).toBe(context);
    expect(persistedTranslations).toHaveLength(26);
    expect(persistedTranslations.every((entry) => entry.engine === 'workers-ai')).toBe(true);
    expect(persistedTranslations.every((entry) => entry.contextRevision === 7)).toBe(true);

    const translationEvents = usageEvents.filter((event) => event.kind === 'translation_character');
    expect(translationEvents).toEqual([
      expect.objectContaining({
        units: 26,
        provider: 'workers-ai-contextual',
        phase: 'started',
        operationKey: 'job:job-1:retry:0:translation:batch-0:workers-ai-contextual',
      }),
      expect.objectContaining({
        units: 26,
        provider: 'workers-ai-contextual',
        phase: 'completed',
        operationKey: 'job:job-1:retry:0:translation:batch-0:workers-ai-contextual',
      }),
      expect.objectContaining({
        units: 1,
        provider: 'workers-ai-contextual',
        phase: 'started',
        operationKey: 'job:job-1:retry:0:translation:batch-25:workers-ai-contextual',
      }),
      expect.objectContaining({
        units: 1,
        provider: 'workers-ai-contextual',
        phase: 'completed',
        operationKey: 'job:job-1:retry:0:translation:batch-25:workers-ai-contextual',
      }),
    ]);
  });

  it('keeps neutral empty Vietnamese context on raw workers-ai with null context provenance', async () => {
    const persisted = [persistedSegment(0, 'x')];
    const usageEvents: UsageRecordInput[] = [];
    const revisions: Array<number | null | undefined> = [];
    const contextTargets: unknown[] = [];
    let contextLoads = 0;
    const context = { revision: 1, style: 'neutral' as const, glossary: [] };
    const infra = baseInfra(persisted, usageEvents);

    const deps = {
      ...infra,
      segments: {
        async list() { return []; },
        async replaceFromAsr() { return persisted; },
        async setTranslationResult(
          _projectId: string,
          _id: string,
          _userId: string,
          _expectedVersion: number,
          _translatedText: string,
          _engine: 'workers-ai' | 'google',
          contextRevision?: number | null,
        ) {
          revisions.push(contextRevision);
          return persisted[0];
        },
      },
      translationContext: {
        async getContext(_projectId: string, _userId: string, targetLanguage?: string) {
          contextLoads += 1;
          contextTargets.push(targetLanguage);
          return context;
        },
      },
      translationRouter: {
        async translate(_mode: unknown, items: Array<{ id: string; text: string }>, _source: string, _target: 'vi', receivedContext: unknown) {
          expect(receivedContext).toBe(context);
          return {
            mode: 'workers-ai' as const,
            primary: items.map((item) => ({ id: item.id, text: `vi:${item.text}`, provider: 'workers-ai' })),
            contextRevision: null,
          };
        },
      },
      translation: {
        capabilities: { contextual: false, available: true },
        async translateBatch() {
          throw new Error('legacy direct translation provider used');
        },
      },
      translationProviderId: 'workers-ai',
    };

    await expect(runDubbingPipeline(
      { projectId: 'project-1', userId: 'dev-user', jobId: 'job-2' },
      deps,
      step,
    )).resolves.toEqual({ status: 'needs_review', segmentCount: 1 });

    expect(contextLoads).toBe(1);
    expect(contextTargets).toEqual(['vi']);
    expect(revisions).toEqual([null]);
    const translationEvents = usageEvents.filter((event) => event.kind === 'translation_character');
    expect(translationEvents).toEqual([
      expect.objectContaining({ provider: 'workers-ai', phase: 'started', units: 1 }),
      expect.objectContaining({ provider: 'workers-ai', phase: 'completed', units: 1 }),
    ]);
  });
});
