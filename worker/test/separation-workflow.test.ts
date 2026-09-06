import { describe, expect, it } from 'vitest';
import type { AudioSeparation } from '../src/db/audio-separation';
import { runSeparationPipeline } from '../src/workflows/separationPipeline';

const project = {
  id: 'p1',
  sourceObjectKey: 'projects/p1/source/source.mp4',
  sourceRevision: 3,
  sizeBytes: 1234,
  durationMs: 90_000,
};

const completed: AudioSeparation = {
  id: 'sep-1', projectId: 'p1', sourceRevision: 3,
  sourceObjectKey: project.sourceObjectKey, sourceSizeBytes: project.sizeBytes,
  provider: 'demucs-container', modelId: 'htdemucs', modelDigest: 'sha256:8726e21a',
  status: 'completed',
  dialogueObjectKey: 'projects/p1/separation/3/demucs-container/sha256-8726e21a/dialogue.wav',
  backgroundObjectKey: 'projects/p1/separation/3/demucs-container/sha256-8726e21a/background.wav',
  jobId: 'job-original', errorCode: null, errorMessage: null,
  createdAt: '', updatedAt: '', completedAt: '2026-09-06T00:00:00Z',
};

function harness(initial: AudioSeparation | null = null, qualified = true) {
  let separation = initial;
  let jobStatus: 'running' | 'cancelled' = 'running';
  const usage = new Map<string, any>();
  const events: string[] = [];
  let providerCalls = 0;
  let completeCalls = 0;
  let createCalls = 0;
  let failCalls = 0;
  let providerError: Error | null = null;
  const deps = {
    projects: { async getByIdForUser() { return project; } },
    jobs: {
      async getForProject() { return { status: jobStatus }; },
      async setProgress() {},
      async complete() {},
      async fail() {},
    },
    separations: {
      async getCurrent() { return separation; },
      async createQueued(input: any) {
        createCalls += 1;
        separation = { ...completed, id: 'sep-new', status: 'queued', jobId: input.jobId, dialogueObjectKey: null, backgroundObjectKey: null, completedAt: null };
        return separation;
      },
      async markRunning() { if (separation) separation = { ...separation, status: 'running' }; },
      async complete(_projectId: string, _id: string, _userId: string, _identity: any, keys: any) {
        completeCalls += 1;
        events.push('separation-complete');
        if (separation) separation = { ...separation, status: 'completed', ...keys };
      },
      async fail(_projectId: string, _id: string, _userId: string, code: string, message: string) {
        failCalls += 1;
        if (separation) separation = { ...separation, status: 'failed', errorCode: code, errorMessage: message };
      },
    },
    provider: {
      async capabilities() { return { configured: true, qualified, provider: 'demucs-container', modelId: 'htdemucs', modelDigest: 'sha256:8726e21a' }; },
      async separate() {
        providerCalls += 1;
        if (providerError) throw providerError;
        return {
          dialogueObjectKey: completed.dialogueObjectKey!,
          backgroundObjectKey: completed.backgroundObjectKey!,
          durationMs: 90_000,
        };
      },
    },
    usage: {
      async getByOperation(key: string, phase: string) { return usage.get(`${key}:${phase}`) ?? null; },
      async record(input: any) {
        if (input.phase === 'completed') events.push('usage-completed');
        const event = { ...input, id: `${input.phase}-1`, costBasis: 0, createdAt: '' };
        const mapKey = `${input.operationKey}:${input.phase}`;
        if (!usage.has(mapKey)) usage.set(mapKey, event);
        return usage.get(mapKey);
      },
    },
    telemetry: { write() {} },
  };
  const step = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
  return {
    deps, step, events,
    setCancelled() { jobStatus = 'cancelled'; },
    failProvider(error = new Error('separator crashed')) { providerError = error; },
    get separation() { return separation; },
    get providerCalls() { return providerCalls; },
    get completeCalls() { return completeCalls; },
    get createCalls() { return createCalls; },
    get failCalls() { return failCalls; },
    usage,
  };
}

const params = { projectId: 'p1', userId: 'u1', jobId: 'job-new' };
const key = 'project:p1:source:3:separation:demucs-container:sha256:8726e21a';

describe('Phase 4D separation workflow', () => {
  it('rejects an unqualified provider before durable or billable work', async () => {
    const h = harness(null, false);
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).rejects.toThrow(/unqualified|qualified/i);
    expect(h.createCalls).toBe(0);
    expect(h.providerCalls).toBe(0);
    expect(h.usage.size).toBe(0);
  });

  it('reuses a completed current-source separation and recovers missing completed usage without provider work', async () => {
    const h = harness(completed);
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).resolves.toMatchObject({
      status: 'completed', separationId: 'sep-1', reused: true, recovered: true,
    });
    expect(h.providerCalls).toBe(0);
    expect(h.usage.get(`${key}:completed`)).toMatchObject({
      kind: 'audio_separation_minute', units: 1.5, phase: 'completed', operationKey: key,
    });
  });

  it('runs one project-scoped separation, persists stems before completed usage, and meters once', async () => {
    const h = harness();
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).resolves.toMatchObject({
      status: 'completed', separationId: 'sep-new', reused: false,
    });
    expect(h.providerCalls).toBe(1);
    expect(h.events).toEqual(['separation-complete', 'usage-completed']);
    expect(h.usage.get(`${key}:completed`)).toMatchObject({
      jobId: 'job-new', kind: 'audio_separation_minute', units: 1.5, provider: 'demucs-container', phase: 'completed', operationKey: key,
    });
    expect(h.separation).toMatchObject({ status: 'completed' });
  });

  it('fails closed when completed usage exists but durable completed stems do not', async () => {
    const running = { ...completed, status: 'running' as const, dialogueObjectKey: null, backgroundObjectKey: null, completedAt: null };
    const h = harness(running);
    h.usage.set(`${key}:completed`, {
      id: 'usage-1', userId: 'u1', projectId: 'p1', jobId: 'job-original', kind: 'audio_separation_minute',
      units: 1.5, provider: 'demucs-container', phase: 'completed', operationKey: key, costBasis: 0, createdAt: '',
    });
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).rejects.toThrow(/invariant|stem|artifact/i);
    expect(h.providerCalls).toBe(0);
    expect(h.completeCalls).toBe(0);
  });

  it('does not publish completion or completed usage when cancellation wins after inference', async () => {
    const h = harness();
    const originalSeparate = h.deps.provider.separate;
    h.deps.provider.separate = async () => {
      const result = await originalSeparate();
      h.setCancelled();
      return result;
    };
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    expect(h.providerCalls).toBe(1);
    expect(h.completeCalls).toBe(0);
    expect(h.usage.get(`${key}:completed`)).toBeUndefined();
  });

  it('marks provider failure without writing completed usage', async () => {
    const h = harness();
    h.failProvider();
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).rejects.toThrow(/separator crashed/i);
    expect(h.failCalls).toBe(1);
    expect(h.separation).toMatchObject({ status: 'failed' });
    expect(h.usage.get(`${key}:completed`)).toBeUndefined();
  });
});
