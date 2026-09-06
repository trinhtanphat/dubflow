import { describe, expect, it } from 'vitest';
import type { AudioSeparation } from '../src/db/audio-separation';
import { runSeparationPipeline } from '../src/workflows/separationPipeline';

const project = {
  id: 'p1',
  sourceObjectKey: 'projects/p1/source/source.mp4',
  sourceRevision: 3,
  sizeBytes: 1234,
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

function harness(initial: AudioSeparation | null = null) {
  let separation = initial;
  let jobStatus: 'running' | 'cancelled' = 'running';
  const usage = new Map<string, any>();
  let providerCalls = 0;
  let completeCalls = 0;
  const deps = {
    projects: { async getByIdForUser() { return project; } },
    jobs: { async getForProject() { return { status: jobStatus }; } },
    separations: {
      async getCurrent() { return separation; },
      async createQueued(input: any) {
        separation = { ...completed, id: 'sep-new', status: 'queued', jobId: input.jobId, dialogueObjectKey: null, backgroundObjectKey: null, completedAt: null };
        return separation;
      },
      async markRunning() { if (separation) separation = { ...separation, status: 'running' }; },
      async complete(_projectId: string, _id: string, _userId: string, _identity: any, keys: any) {
        completeCalls += 1;
        if (separation) separation = { ...separation, status: 'completed', ...keys };
      },
      async fail(_projectId: string, _id: string, _userId: string, code: string, message: string) {
        if (separation) separation = { ...separation, status: 'failed', errorCode: code, errorMessage: message };
      },
    },
    provider: {
      async capabilities() { return { configured: true, qualified: false, provider: 'demucs-container', modelId: 'htdemucs', modelDigest: 'sha256:8726e21a' }; },
      async separate() {
        providerCalls += 1;
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
        const event = { ...input, id: `${input.phase}-1`, costBasis: 0, createdAt: '' };
        const mapKey = `${input.operationKey}:${input.phase}`;
        if (!usage.has(mapKey)) usage.set(mapKey, event);
        return usage.get(mapKey);
      },
    },
  };
  const step = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
  return {
    deps, step,
    setCancelled() { jobStatus = 'cancelled'; },
    get separation() { return separation; },
    get providerCalls() { return providerCalls; },
    get completeCalls() { return completeCalls; },
    usage,
  };
}

const params = { projectId: 'p1', userId: 'u1', jobId: 'job-new' };

describe('Phase 4D separation workflow', () => {
  it('reuses an already completed current-source separation without provider work or new usage', async () => {
    const h = harness(completed);
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).resolves.toMatchObject({
      status: 'completed', separationId: 'sep-1', reused: true,
    });
    expect(h.providerCalls).toBe(0);
    expect(h.usage.size).toBe(0);
  });

  it('runs one project-scoped separation and meters completed provider minutes once', async () => {
    const h = harness();
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).resolves.toMatchObject({
      status: 'completed', separationId: 'sep-new', reused: false,
    });
    expect(h.providerCalls).toBe(1);
    const key = 'project:p1:source:3:separation:demucs-container:sha256:8726e21a';
    expect(h.usage.get(`${key}:completed`)).toMatchObject({
      jobId: 'job-new', kind: 'audio_separation_minute', units: 1.5, provider: 'demucs-container', phase: 'completed', operationKey: key,
    });
    expect(h.separation).toMatchObject({ status: 'completed' });
  });

  it('recovers a running separation from durable completed usage without invoking the provider again', async () => {
    const running = { ...completed, status: 'running' as const, dialogueObjectKey: null, backgroundObjectKey: null, completedAt: null };
    const h = harness(running);
    const key = 'project:p1:source:3:separation:demucs-container:sha256:8726e21a';
    h.usage.set(`${key}:completed`, {
      id: 'usage-1', userId: 'u1', projectId: 'p1', jobId: 'job-original', kind: 'audio_separation_minute',
      units: 1.5, provider: 'demucs-container', phase: 'completed', operationKey: key, costBasis: 0, createdAt: '',
    });
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).resolves.toMatchObject({
      status: 'completed', separationId: 'sep-1', reused: true, recovered: true,
    });
    expect(h.providerCalls).toBe(0);
    expect(h.completeCalls).toBe(1);
  });

  it('meters provider work but refuses to persist completion when cancellation wins after separation', async () => {
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
    expect([...h.usage.values()].some((event) => event.phase === 'completed')).toBe(true);
  });
});
