import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createJobRoutes } from '../src/routes/jobs';
import type { DubbingJob, JobStore } from '../src/db/jobs';
import type { UsageStore } from '../src/db/usage';
import type { UsageSummary } from '../src/domain/usage';

const summary: UsageSummary = {
  allocatedCredits: 50_000,
  usedCredits: 25,
  remainingCredits: 49_975,
  overageCredits: 0,
  totals: [{ kind: 'translation_characters', units: 5_000, credits: 25 }],
  providers: [{ provider: 'workers-ai', kind: 'translation_characters', units: 5_000, credits: 25 }],
};

function usageStore(value: UsageSummary | Error): UsageStore {
  return {
    async record() { throw new Error('record is not used by summary route'); },
    async summaryForUser(userId) {
      expect(userId).toBe('dev-user');
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

async function usageApp(store: UsageStore) {
  const modulePath = '../src/routes/' + 'usage';
  const { createUsageRoutes } = await import(modulePath) as {
    createUsageRoutes(makeStore?: (env: Env) => UsageStore): ReturnType<Hono<{ Bindings: Env }>['basePath']>;
  };
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/usage', createUsageRoutes(() => store) as never);
  return app;
}

function failedJob(): DubbingJob {
  return {
    id: 'j1', projectId: 'p1', type: 'dubbing', status: 'failed', progress: 0.6,
    currentStep: 'transcribing', errorCode: 'ASR_FAILED', errorMessage: 'boom', retryCount: 1,
    createdAt: '2026-09-05T17:00:00Z', updatedAt: '2026-09-05T17:01:00Z',
  };
}

class RetryStore implements JobStore {
  row = failedJob();
  async create() { return this.row; }
  async listForProject() { return [this.row]; }
  async getForProject(_projectId: string, jobId: string, userId: string) {
    return jobId === this.row.id && userId === 'dev-user' ? this.row : null;
  }
  async markRetrying() {
    this.row = { ...this.row, status: 'retrying', progress: 0, currentStep: 'retrying', retryCount: 2 };
    return this.row;
  }
  async cancel() { return this.row; }
  async isCancelled() { return false; }
  async setProgress() {}
  async fail() {}
  async complete() {}
}

describe('Phase 3B usage summary API and retry attempt propagation', () => {
  it('returns the current user usage summary', async () => {
    const app = await usageApp(usageStore(summary));
    const response = await app.request('/api/usage/summary', {}, {} as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
  });

  it('fails closed when usage summary persistence cannot be read', async () => {
    const app = await usageApp(usageStore(new Error('D1 unavailable')));
    const response = await app.request('/api/usage/summary', {}, {} as Env);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: true, code: 'USAGE_SUMMARY_FAILED' });
  });

  it('passes the incremented retry count as the new usage attempt', async () => {
    const creates: unknown[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createJobRoutes({
      makeStore: () => new RetryStore(),
      startWorkflow: async (_env, job, params) => {
        creates.push({ id: `retry-${job.id}-${job.retryCount}`, params });
        return { id: 'wf-j1-2' };
      },
    }));

    const response = await app.request('/api/projects/p1/jobs/j1/retry', { method: 'POST' }, {} as Env);
    expect(response.status).toBe(202);
    expect(creates).toEqual([{
      id: 'retry-j1-2',
      params: { projectId: 'p1', userId: 'dev-user', jobId: 'j1', usageAttempt: 2 },
    }]);
  });
});
