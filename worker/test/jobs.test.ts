import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import {
  JobStateError,
  assertProgressTransition,
  type DubbingJob,
  type JobStore,
} from '../src/db/jobs';
import { createJobRoutes } from '../src/routes/jobs';

class MemoryJobStore implements JobStore {
  jobs = new Map<string, DubbingJob>();

  async create(projectId: string, type: string): Promise<DubbingJob> {
    const job: DubbingJob = {
      id: 'job-1',
      projectId,
      type,
      status: 'queued',
      progress: 0,
      currentStep: null,
      errorCode: null,
      errorMessage: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async getForProject(projectId: string, jobId: string, userId: string): Promise<DubbingJob | null> {
    if (userId !== 'dev-user') return null;
    const job = this.jobs.get(jobId);
    return job?.projectId === projectId ? job : null;
  }

  async setProgress(jobId: string, progress: number, currentStep: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    assertProgressTransition(job.progress, progress);
    this.jobs.set(jobId, { ...job, status: 'running', progress, currentStep });
  }

  async fail(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    this.jobs.set(jobId, { ...job, status: 'failed', errorCode, errorMessage });
  }

  async complete(jobId: string, status: 'completed' | 'needs_review' = 'completed'): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    this.jobs.set(jobId, { ...job, status, progress: 1, currentStep: status });
  }
}

function makeApp(store: JobStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createJobRoutes(() => store));
  return app;
}

describe('durable dubbing jobs', () => {
  it('enforces bounded monotonic progress', () => {
    expect(() => assertProgressTransition(0.25, 0.5)).not.toThrow();
    expect(() => assertProgressTransition(0.5, 0.49)).toThrowError(JobStateError);
    expect(() => assertProgressTransition(0.5, 1.01)).toThrowError(JobStateError);
    expect(() => assertProgressTransition(0.5, Number.NaN)).toThrowError(JobStateError);
  });

  it('returns only jobs belonging to the requested project/current user', async () => {
    const store = new MemoryJobStore();
    const job = await store.create('project-1', 'dubbing');
    const app = makeApp(store);

    const owned = await app.request(`/api/projects/project-1/jobs/${job.id}`);
    expect(owned.status).toBe(200);
    expect(await owned.json()).toEqual(job);

    const foreign = await app.request(`/api/projects/project-2/jobs/${job.id}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: true, code: 'JOB_NOT_FOUND' });
  });

  it('persists progress, failure details, and terminal completion in the store contract', async () => {
    const store = new MemoryJobStore();
    const job = await store.create('project-1', 'dubbing');

    await store.setProgress(job.id, 0.4, 'asr');
    expect(store.jobs.get(job.id)).toMatchObject({ status: 'running', progress: 0.4, currentStep: 'asr' });

    await store.fail(job.id, 'ASR_FAILED', 'Transcription failed.');
    expect(store.jobs.get(job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'ASR_FAILED',
      errorMessage: 'Transcription failed.',
    });

    const retry = await store.create('project-1', 'dubbing');
    await store.complete(retry.id, 'needs_review');
    expect(store.jobs.get(retry.id)).toMatchObject({ status: 'needs_review', progress: 1 });
  });
});
