import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { JobStateError, type DubbingJob, type JobStore } from '../src/db/jobs';
import { createJobRoutes } from '../src/routes/jobs';

function job(overrides: Partial<DubbingJob> = {}): DubbingJob {
  return {
    id: 'j1',
    projectId: 'p1',
    type: 'dubbing',
    status: 'failed',
    progress: 0.6,
    currentStep: 'transcribing',
    errorCode: 'ASR_FAILED',
    errorMessage: 'boom',
    retryCount: 1,
    createdAt: '2026-09-05T12:00:00Z',
    updatedAt: '2026-09-05T12:05:00Z',
    ...overrides,
  };
}

class RouteJobStore implements JobStore {
  rows = new Map<string, DubbingJob>([['j1', job()], ['j2', job({ id: 'j2', type: 'export', createdAt: '2026-09-05T13:00:00Z' })]]);

  async create(projectId: string, type: string) { return job({ projectId, type }); }
  async listForProject(projectId: string, userId: string) {
    if (userId !== 'dev-user') return [];
    return [...this.rows.values()].filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getForProject(projectId: string, jobId: string, userId: string) {
    if (userId !== 'dev-user') return null;
    const row = this.rows.get(jobId);
    return row?.projectId === projectId ? row : null;
  }
  async markRetrying(projectId: string, jobId: string, userId: string) {
    const current = await this.getForProject(projectId, jobId, userId);
    if (!current) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    if (current.status !== 'failed') throw new JobStateError('JOB_NOT_RETRYABLE', 'Job is not retryable.');
    const next = job({ ...current, status: 'retrying', progress: 0, currentStep: 'retrying', errorCode: null, errorMessage: null, retryCount: current.retryCount + 1 });
    this.rows.set(jobId, next);
    return next;
  }
  async cancel(projectId: string, jobId: string, userId: string) {
    const current = await this.getForProject(projectId, jobId, userId);
    if (!current) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    if (!['queued', 'running', 'retrying'].includes(current.status)) throw new JobStateError('JOB_NOT_CANCELLABLE', 'Job is not cancellable.');
    const next = job({ ...current, status: 'cancelled', currentStep: 'cancelled' });
    this.rows.set(jobId, next);
    return next;
  }
  async isCancelled(projectId: string, jobId: string, userId: string) { return (await this.getForProject(projectId, jobId, userId))?.status === 'cancelled'; }
  async setProgress() {}
  async fail(jobId: string, errorCode: string, errorMessage: string) {
    const current = this.rows.get(jobId);
    if (current) this.rows.set(jobId, job({ ...current, status: 'failed', errorCode, errorMessage }));
  }
  async complete() {}
}

function makeApp(store: JobStore, workflowCreates: unknown[]) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createJobRoutes({
    makeStore: () => store,
    startWorkflow: async (_env, current, params) => {
      const input = { id: `retry-${current.id}-${current.retryCount}`, params };
      workflowCreates.push(input);
      return { id: `wf-${current.id}-${current.retryCount}` };
    },
  }));
  return app;
}

const env = {} as Env;

describe('durable job control routes', () => {
  it('lists authorized project job history newest first', async () => {
    const app = makeApp(new RouteJobStore(), []);
    const response = await app.request('/api/projects/p1/jobs', {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as DubbingJob[];
    expect(body.map((item) => item.id)).toEqual(['j2', 'j1']);
    expect(body[0]).toMatchObject({ retryCount: 1, createdAt: '2026-09-05T13:00:00Z' });
  });

  it('retries the same failed job generation and starts a deterministic workflow', async () => {
    const creates: unknown[] = [];
    const app = makeApp(new RouteJobStore(), creates);
    const response = await app.request('/api/projects/p1/jobs/j1/retry', { method: 'POST' }, env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: 'j1', workflowId: 'wf-j1-2', status: 'retrying' });
    expect(creates).toEqual([{
      id: 'retry-j1-2',
      params: { projectId: 'p1', userId: 'dev-user', jobId: 'j1', usageAttempt: 2 },
    }]);
  });

  it('cancels an active job and returns canonical cancelled state', async () => {
    const store = new RouteJobStore();
    store.rows.set('j1', job({ status: 'running', errorCode: null, errorMessage: null }));
    const app = makeApp(store, []);
    const response = await app.request('/api/projects/p1/jobs/j1/cancel', { method: 'POST' }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'j1', status: 'cancelled', currentStep: 'cancelled' });
  });

  it('maps missing and invalid transitions without starting workflows', async () => {
    const creates: unknown[] = [];
    const store = new RouteJobStore();
    store.rows.set('j1', job({ status: 'running' }));
    const app = makeApp(store, creates);

    const missing = await app.request('/api/projects/p1/jobs/missing/retry', { method: 'POST' }, env);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'JOB_NOT_FOUND' });

    const stale = await app.request('/api/projects/p1/jobs/j1/retry', { method: 'POST' }, env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'JOB_NOT_RETRYABLE' });

    store.rows.set('j1', job({ status: 'completed' }));
    const terminalCancel = await app.request('/api/projects/p1/jobs/j1/cancel', { method: 'POST' }, env);
    expect(terminalCancel.status).toBe(409);
    expect(await terminalCancel.json()).toMatchObject({ code: 'JOB_NOT_CANCELLABLE' });
    expect(creates).toEqual([]);
  });

  it('rejects unsupported retry job types before workflow dispatch', async () => {
    const creates: unknown[] = [];
    const store = new RouteJobStore();
    store.rows.set('j1', job({ type: 'mystery' }));
    const app = makeApp(store, creates);
    const response = await app.request('/api/projects/p1/jobs/j1/retry', { method: 'POST' }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'JOB_TYPE_UNSUPPORTED' });
    expect(creates).toEqual([]);
  });
});
