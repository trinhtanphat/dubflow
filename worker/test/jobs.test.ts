import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import {
  JobRepository,
  JobStateError,
  assertProgressTransition,
  type DubbingJob,
  type JobStore,
} from '../src/db/jobs';
import { createJobRoutes } from '../src/routes/jobs';

class MemoryJobStore implements JobStore {
  jobs = new Map<string, DubbingJob>();

  async create(projectId: string, type: string): Promise<DubbingJob> {
    const now = '2026-09-05T00:00:00Z';
    const job: DubbingJob = {
      id: 'job-1',
      projectId,
      type,
      status: 'queued',
      progress: 0,
      currentStep: null,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async listForProject(projectId: string, userId: string): Promise<DubbingJob[]> {
    if (userId !== 'dev-user') return [];
    return [...this.jobs.values()].filter((job) => job.projectId === projectId);
  }

  async getForProject(projectId: string, jobId: string, userId: string): Promise<DubbingJob | null> {
    if (userId !== 'dev-user') return null;
    const job = this.jobs.get(jobId);
    return job?.projectId === projectId ? job : null;
  }

  async markRetrying(projectId: string, jobId: string, userId: string): Promise<DubbingJob> {
    const job = await this.getForProject(projectId, jobId, userId);
    if (!job) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    if (job.status !== 'failed') throw new JobStateError('JOB_NOT_RETRYABLE', 'Only failed jobs can be retried.');
    const updated = {
      ...job,
      status: 'retrying' as const,
      progress: 0,
      currentStep: 'retrying',
      errorCode: null,
      errorMessage: null,
      retryCount: job.retryCount + 1,
      updatedAt: '2026-09-05T00:01:00Z',
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async cancel(projectId: string, jobId: string, userId: string): Promise<DubbingJob> {
    const job = await this.getForProject(projectId, jobId, userId);
    if (!job) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    if (!['queued', 'running', 'retrying'].includes(job.status)) {
      throw new JobStateError('JOB_NOT_CANCELLABLE', 'Only active jobs can be cancelled.');
    }
    const updated = { ...job, status: 'cancelled' as const, currentStep: 'cancelled' };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async isCancelled(projectId: string, jobId: string, userId: string): Promise<boolean> {
    return (await this.getForProject(projectId, jobId, userId))?.status === 'cancelled';
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
    if (job.status === 'cancelled') return;
    this.jobs.set(jobId, { ...job, status: 'failed', errorCode, errorMessage });
  }

  async complete(jobId: string, status: 'completed' | 'needs_review' = 'completed'): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    if (job.status === 'cancelled') return;
    this.jobs.set(jobId, { ...job, status, progress: 1, currentStep: status });
  }
}

function makeApp(store: JobStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createJobRoutes(() => store));
  return app;
}

function listDb() {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare(statement: string) {
        sql.push(statement);
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async run() { return { meta: { changes: 1 } }; },
          async first<T>() { return null as T | null; },
          async all<T>() {
            expect(values).toEqual(['p1', 'dev-user']);
            return {
              results: [{
                id: 'j2', project_id: 'p1', type: 'export', status: 'failed', progress: 0.6,
                current_step: 'rendering', error_code: 'RENDER_FAILED', error_message: 'boom',
                retry_count: 2, created_at: '2026-09-05T12:00:00Z', updated_at: '2026-09-05T12:05:00Z',
              }] as T[],
            };
          },
        };
      },
    },
  };
}

function transitionDb(initialStatus: DubbingJob['status'], initialRetryCount = 1) {
  let row = {
    id: 'j1', project_id: 'p1', type: 'dubbing', status: initialStatus, progress: 0.7,
    current_step: 'transcribing', error_code: 'ASR_FAILED' as string | null, error_message: 'boom' as string | null,
    retry_count: initialRetryCount, created_at: '2026-09-05T12:00:00Z', updated_at: '2026-09-05T12:05:00Z',
  };
  return {
    get row() { return row; },
    db: {
      prepare(statement: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async all<T>() { return { results: [] as T[] }; },
          async first<T>() {
            if (statement.includes('FROM jobs j')) {
              const [projectId, jobId, userId] = values;
              return projectId === 'p1' && jobId === 'j1' && userId === 'dev-user' ? row as T : null;
            }
            if (statement.includes('FROM jobs WHERE id = ?')) {
              return values[0] === 'j1' ? row as T : null;
            }
            return null;
          },
          async run() {
            if (statement.includes("SET status = 'retrying'")) {
              const [jobId, projectId, userId] = values;
              if (jobId === 'j1' && projectId === 'p1' && userId === 'dev-user' && row.status === 'failed') {
                row = {
                  ...row,
                  status: 'retrying',
                  progress: 0,
                  current_step: 'retrying',
                  error_code: null,
                  error_message: null,
                  retry_count: row.retry_count + 1,
                };
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            if (statement.includes("SET status = 'cancelled'")) {
              const [jobId, projectId, userId] = values;
              if (jobId === 'j1' && projectId === 'p1' && userId === 'dev-user' && ['queued', 'running', 'retrying'].includes(row.status)) {
                row = { ...row, status: 'cancelled', current_step: 'cancelled' };
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
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

  it('lists authorized project jobs with durable retry and timestamp metadata', async () => {
    const { db, sql } = listDb();
    const repo = new JobRepository(db);
    await expect(repo.listForProject('p1', 'dev-user')).resolves.toEqual([
      expect.objectContaining({
        id: 'j2', retryCount: 2,
        createdAt: '2026-09-05T12:00:00Z', updatedAt: '2026-09-05T12:05:00Z',
      }),
    ]);
    expect(sql.join('\n')).toMatch(/ORDER BY j\.created_at DESC/i);
  });

  it('retries only a failed authorized job and increments the durable generation', async () => {
    const state = transitionDb('failed', 1);
    const repo = new JobRepository(state.db);
    await expect(repo.markRetrying('p1', 'j1', 'dev-user')).resolves.toMatchObject({
      status: 'retrying', progress: 0, retryCount: 2, errorCode: null, errorMessage: null,
    });
  });

  it('rejects retry from a non-failed job', async () => {
    const state = transitionDb('running');
    const repo = new JobRepository(state.db);
    await expect(repo.markRetrying('p1', 'j1', 'dev-user')).rejects.toMatchObject({ code: 'JOB_NOT_RETRYABLE' });
  });

  it('cancels only an active authorized job', async () => {
    const running = transitionDb('running');
    await expect(new JobRepository(running.db).cancel('p1', 'j1', 'dev-user'))
      .resolves.toMatchObject({ status: 'cancelled' });

    const completed = transitionDb('completed');
    await expect(new JobRepository(completed.db).cancel('p1', 'j1', 'dev-user'))
      .rejects.toMatchObject({ code: 'JOB_NOT_CANCELLABLE' });
  });
});
