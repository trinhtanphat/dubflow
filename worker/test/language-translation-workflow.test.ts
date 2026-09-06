import { describe, expect, it } from 'vitest';
import type { UsageRecordInput } from '../src/db/usage';
import { runLanguageTranslationPipeline } from '../src/workflows/languageTranslationPipeline';

const step = {
  async do<T>(_name: string, callback: () => Promise<T>) {
    return callback();
  },
};

function canonicalSegment(index: number) {
  return {
    id: `seg-${index}`,
    projectId: 'project-1',
    speakerId: 'speaker-1',
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    sourceText: index === 0 ? 'A😀' : 'x',
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

function makeDeps(options: { failSecondBatch?: boolean } = {}) {
  const segments = Array.from({ length: 26 }, (_, index) => canonicalSegment(index));
  const context = { revision: 7, style: 'natural' as const, glossary: [] };
  const contextTargets: string[] = [];
  const routerTargets: string[] = [];
  const routerContexts: unknown[] = [];
  const routerItems: Array<Array<{ id: string; text: string }>> = [];
  const persisted: Array<{ segmentId: string; target: string; engine: string; contextRevision: number | null }> = [];
  const languageStatuses: Array<{ target: string; status: string }> = [];
  const usageEvents: UsageRecordInput[] = [];
  const uniqueUsage = new Map<string, UsageRecordInput>();
  const jobEvents: Array<{ kind: string; code?: string }> = [];
  let contextLoads = 0;
  let routerCalls = 0;

  const deps = {
    projects: {
      async getByIdForUser(projectId: string, userId: string) {
        expect(projectId).toBe('project-1');
        expect(userId).toBe('dev-user');
        return { id: projectId, sourceLanguage: 'en' as const };
      },
    },
    jobs: {
      async getForProject() { return { status: 'running' as const, retryCount: 0 }; },
      async setProgress() {},
      async fail(_jobId: string, code: string) { jobEvents.push({ kind: 'failed', code }); },
      async complete() { jobEvents.push({ kind: 'completed' }); },
    },
    segments: {
      async list() { return segments; },
    },
    variants: {
      async setTranslationResult(
        _projectId: string,
        segmentId: string,
        _userId: string,
        target: string,
        _text: string,
        engine: string,
        contextRevision: number | null,
      ) {
        persisted.push({ segmentId, target, engine, contextRevision });
        return {};
      },
    },
    languages: {
      async setStatus(_projectId: string, _userId: string, target: string, status: string) {
        languageStatuses.push({ target, status });
      },
    },
    translationContext: {
      async getContext(_projectId: string, _userId: string, target: string) {
        contextLoads += 1;
        contextTargets.push(target);
        return context;
      },
    },
    translationRouter: {
      async translate(
        mode: unknown,
        items: Array<{ id: string; text: string }>,
        source: string,
        target: string,
        receivedContext: unknown,
      ) {
        expect(mode).toBeUndefined();
        expect(source).toBe('en');
        routerCalls += 1;
        routerTargets.push(target);
        routerContexts.push(receivedContext);
        routerItems.push(items);
        if (options.failSecondBatch && routerCalls === 2) throw new Error('provider failed');
        return {
          mode: 'contextual' as const,
          primary: items.map((item) => ({
            id: item.id,
            text: `ja:${item.text}`,
            provider: 'workers-ai-contextual',
          })),
          contextRevision: 7,
        };
      },
    },
    usage: {
      async record(input: UsageRecordInput) {
        usageEvents.push(input);
        uniqueUsage.set(`${input.operationKey}:${input.phase}`, input);
        return input as never;
      },
    },
    telemetry: { write() {} },
  };

  return {
    deps,
    context,
    contextTargets,
    routerTargets,
    routerContexts,
    routerItems,
    persisted,
    languageStatuses,
    usageEvents,
    uniqueUsage,
    jobEvents,
    get contextLoads() { return contextLoads; },
  };
}

describe('Phase 4C target translation workflow', () => {
  it('translates 26 canonical segments into JA in two context-stable, Unicode-metered batches', async () => {
    const state = makeDeps();

    await expect(runLanguageTranslationPipeline(
      {
        projectId: 'project-1',
        userId: 'dev-user',
        jobId: 'job-1',
        targetLanguage: 'ja',
        requestId: 'req-1',
      },
      state.deps as never,
      step,
    )).resolves.toEqual({ status: 'needs_review', targetLanguage: 'ja', segmentCount: 26 });

    expect(state.contextLoads).toBe(1);
    expect(state.contextTargets).toEqual(['ja']);
    expect(state.routerTargets).toEqual(['ja', 'ja']);
    expect(state.routerContexts).toHaveLength(2);
    expect(state.routerContexts[0]).toBe(state.context);
    expect(state.routerContexts[1]).toBe(state.context);
    expect(state.routerItems.map((items) => items.length)).toEqual([25, 1]);
    expect(state.persisted).toHaveLength(26);
    expect(state.persisted.every((entry) => entry.target === 'ja')).toBe(true);
    expect(state.persisted.every((entry) => entry.engine === 'workers-ai')).toBe(true);
    expect(state.persisted.every((entry) => entry.contextRevision === 7)).toBe(true);

    const translationEvents = state.usageEvents.filter((event) => event.kind === 'translation_character');
    expect(translationEvents).toEqual([
      expect.objectContaining({
        units: 26,
        provider: 'workers-ai-contextual',
        phase: 'started',
        operationKey: 'job:job-1:retry:0:translation:ja:batch-0:workers-ai-contextual',
      }),
      expect.objectContaining({
        units: 26,
        provider: 'workers-ai-contextual',
        phase: 'completed',
        operationKey: 'job:job-1:retry:0:translation:ja:batch-0:workers-ai-contextual',
      }),
      expect.objectContaining({
        units: 1,
        provider: 'workers-ai-contextual',
        phase: 'started',
        operationKey: 'job:job-1:retry:0:translation:ja:batch-25:workers-ai-contextual',
      }),
      expect.objectContaining({
        units: 1,
        provider: 'workers-ai-contextual',
        phase: 'completed',
        operationKey: 'job:job-1:retry:0:translation:ja:batch-25:workers-ai-contextual',
      }),
    ]);
    expect(state.languageStatuses).toEqual([
      { target: 'ja', status: 'translating' },
      { target: 'ja', status: 'needs_review' },
    ]);
    expect(state.jobEvents).toEqual([{ kind: 'completed' }]);
  });

  it('fails only the requested target and keeps usage phases idempotent by operation key', async () => {
    const state = makeDeps({ failSecondBatch: true });

    await expect(runLanguageTranslationPipeline(
      {
        projectId: 'project-1',
        userId: 'dev-user',
        jobId: 'job-2',
        targetLanguage: 'ja',
      },
      state.deps as never,
      step,
    )).rejects.toThrow('provider failed');

    expect(state.languageStatuses).toEqual([
      { target: 'ja', status: 'translating' },
      { target: 'ja', status: 'failed' },
    ]);
    expect(state.languageStatuses.some((entry) => entry.target === 'vi' || entry.target === 'ko')).toBe(false);
    expect(state.jobEvents).toEqual([{ kind: 'failed', code: 'TRANSLATION_FAILED' }]);

    const firstBatchCompleted = [...state.uniqueUsage.values()].filter((event) =>
      event.operationKey.includes('translation:ja:batch-0') && event.phase === 'completed');
    expect(firstBatchCompleted).toHaveLength(1);
    const failedBatchCompleted = [...state.uniqueUsage.values()].filter((event) =>
      event.operationKey.includes('translation:ja:batch-25') && event.phase === 'completed');
    expect(failedBatchCompleted).toHaveLength(0);
  });
});
