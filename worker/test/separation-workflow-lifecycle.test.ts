import { describe, expect, it } from 'vitest';
import { runSeparationPipeline } from '../src/workflows/separationPipeline';

function lifecycleHarness(options: { cancelAfterProvider?: boolean; providerFails?: boolean } = {}) {
  let separation: any = null;
  let cancelled = false;
  const jobEvents: string[] = [];
  const telemetryEvents: any[] = [];
  const project = {
    id: 'p1',
    sourceObjectKey: 'projects/p1/source/source.mp4',
    sourceRevision: 2,
    sizeBytes: 2048,
    durationMs: 60_000,
  };
  const capabilities = {
    configured: true,
    qualified: true,
    provider: 'demucs-container',
    modelId: 'htdemucs',
    modelDigest: 'sha256:8726e21a',
  };
  const deps = {
    projects: { async getByIdForUser() { return project; } },
    jobs: {
      async getForProject() { return { status: cancelled ? 'cancelled' : 'running' }; },
      async setProgress(_jobId: string, _progress: number, currentStep: string) { jobEvents.push(`progress:${currentStep}`); },
      async complete() { jobEvents.push('complete'); },
      async fail(_jobId: string, code: string) { jobEvents.push(`fail:${code}`); },
    },
    separations: {
      async getCurrent() { return separation; },
      async createQueued() {
        separation = {
          id: 'sep-1', projectId: 'p1', sourceRevision: 2,
          sourceObjectKey: project.sourceObjectKey, sourceSizeBytes: project.sizeBytes,
          provider: capabilities.provider, modelId: capabilities.modelId, modelDigest: capabilities.modelDigest,
          status: 'queued', backgroundObjectKey: null, dialogueObjectKey: null, jobId: 'job-1',
          errorCode: null, errorMessage: null, createdAt: '', updatedAt: '', completedAt: null,
        };
        return separation;
      },
      async markRunning() { separation = { ...separation, status: 'running' }; },
      async complete(_projectId: string, _id: string, _userId: string, _identity: any, keys: any) {
        separation = { ...separation, status: 'completed', ...keys };
      },
      async fail() { separation = { ...separation, status: 'failed' }; },
    },
    provider: {
      async capabilities() { return capabilities; },
      async separate() {
        if (options.providerFails) throw new Error('separator failed');
        if (options.cancelAfterProvider) cancelled = true;
        return {
          dialogueObjectKey: 'projects/p1/separation/2/demucs-container/sha256-8726e21a/dialogue.wav',
          backgroundObjectKey: 'projects/p1/separation/2/demucs-container/sha256-8726e21a/background.wav',
          durationMs: 60_000,
        };
      },
    },
    usage: {
      async getByOperation() { return null; },
      async record(input: any) { return input; },
    },
    telemetry: { write(event: any) { telemetryEvents.push(event); } },
  };
  const step = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };
  return { deps, step, jobEvents, telemetryEvents };
}

const params = { projectId: 'p1', userId: 'u1', jobId: 'job-1', requestId: 'req-1' } as any;

describe('Phase 4D separation workflow lifecycle and telemetry', () => {
  it('marks durable job progress and completes only after separation and usage complete', async () => {
    const h = lifecycleHarness();
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).resolves.toMatchObject({ status: 'completed' });
    expect(h.jobEvents).toEqual(['progress:separating_audio', 'complete']);
    expect(h.telemetryEvents).toContainEqual(expect.objectContaining({
      name: 'provider_success', requestId: 'req-1', actorId: 'u1', projectId: 'p1', jobId: 'job-1',
      operation: 'audio_separation', provider: 'demucs-container', status: 'success',
    }));
  });

  it('emits provider failure telemetry and fails the durable job', async () => {
    const h = lifecycleHarness({ providerFails: true });
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).rejects.toThrow(/separator failed/i);
    expect(h.jobEvents).toContain('fail:SEPARATION_FAILED');
    expect(h.jobEvents).not.toContain('complete');
    expect(h.telemetryEvents).toContainEqual(expect.objectContaining({
      name: 'provider_failure', operation: 'audio_separation', provider: 'demucs-container', status: 'failure',
      errorCode: 'SEPARATION_FAILED',
    }));
  });

  it('does not complete the durable job when cancellation wins after provider inference', async () => {
    const h = lifecycleHarness({ cancelAfterProvider: true });
    await expect(runSeparationPipeline(params, h.deps as any, h.step)).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
    expect(h.jobEvents).toContain('progress:separating_audio');
    expect(h.jobEvents).not.toContain('complete');
    expect(h.jobEvents.some((entry) => entry.startsWith('fail:'))).toBe(false);
  });
});
