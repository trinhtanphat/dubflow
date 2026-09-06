import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createSeparationRoutes } from '../src/routes/separation';

const analytics = { writeDataPoint() {} };
const project = {
  id: 'p1', userId: 'dev-user', title: 'Movie', sourceLanguage: 'zh' as const, targetLanguage: 'vi' as const,
  targetLanguagesRevision: 1, sourceRevision: 2, status: 'ready' as const,
  sourceObjectKey: 'projects/p1/source/movie.mp4', sizeBytes: 2048, durationMs: 60_000,
};
const identity = { configured: true, qualified: true, provider: 'demucs-container', modelId: 'htdemucs', modelDigest: 'sha256:8726e21a' };
const completed = {
  id: 'sep-1', projectId: 'p1', sourceRevision: 2, sourceObjectKey: project.sourceObjectKey, sourceSizeBytes: project.sizeBytes,
  provider: identity.provider, modelId: identity.modelId, modelDigest: identity.modelDigest, status: 'completed' as const,
  backgroundObjectKey: 'projects/p1/separation/2/demucs-container/sha256-8726e21a/background.wav',
  dialogueObjectKey: 'projects/p1/separation/2/demucs-container/sha256-8726e21a/dialogue.wav',
  jobId: 'job-old', errorCode: null, errorMessage: null, createdAt: '2026-09-06T00:00:00Z', updatedAt: '', completedAt: '2026-09-06T00:01:00Z',
};

function harness(current: any = null) {
  let separation = current;
  let limiterCalls = 0;
  let workflowCalls = 0;
  let createSeparationCalls = 0;
  let createJobCalls = 0;
  let retryCalls = 0;
  const projects = { async getByIdForUser(id: string, userId: string) { return id === 'p1' && userId === 'dev-user' ? project : null; } };
  const jobs = {
    async create() { createJobCalls += 1; return { id: 'job-new', projectId: 'p1', type: 'audio_separation', status: 'queued', retryCount: 0 }; },
    async markRetrying() { retryCalls += 1; return { id: separation.jobId, projectId: 'p1', type: 'audio_separation', status: 'retrying', retryCount: 1 }; },
  };
  const separations = {
    async getCurrent() { return separation; },
    async createQueued(input: any) {
      createSeparationCalls += 1;
      separation = { ...completed, id: 'sep-new', status: 'queued', jobId: input.jobId, backgroundObjectKey: null, dialogueObjectKey: null, completedAt: null };
      return separation;
    },
  };
  const provider = { async capabilities() { return identity; }, async separate() { throw new Error('route must not invoke provider directly'); } };
  const app = new Hono<any>();
  app.route('/api/projects', createSeparationRoutes({
    makeProjects: () => projects as any,
    makeJobs: () => jobs as any,
    makeSeparations: () => separations as any,
    makeProvider: () => provider as any,
  }));
  const env = {
    ANALYTICS: analytics,
    RATE_LIMIT_SEPARATION: { async limit() { limiterCalls += 1; return { success: true }; } },
    SEPARATION_WORKFLOW: { async create() { workflowCalls += 1; return { id: 'wf-1' }; } },
  } as unknown as Env;
  return { app, env, get limiterCalls() { return limiterCalls; }, get workflowCalls() { return workflowCalls; }, get createSeparationCalls() { return createSeparationCalls; }, get createJobCalls() { return createJobCalls; }, get retryCalls() { return retryCalls; } };
}

describe('Phase 4D separation routes', () => {
  it('returns a completed current identity without consuming limiter or starting workflow', async () => {
    const h = harness(completed);
    const response = await h.app.request('/api/projects/p1/separation', { method: 'POST' }, h.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'completed', reused: true, separation: { id: 'sep-1', sourceRevision: 2, provider: 'demucs-container', modelId: 'htdemucs', jobId: 'job-old' } });
    expect(h.limiterCalls).toBe(0);
    expect(h.workflowCalls).toBe(0);
    expect(h.createJobCalls).toBe(0);
  });

  it('returns an active identity without consuming limiter or duplicating provider work', async () => {
    const h = harness({ ...completed, status: 'running', completedAt: null, backgroundObjectKey: null, dialogueObjectKey: null });
    const response = await h.app.request('/api/projects/p1/separation', { method: 'POST' }, h.env);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'running', reused: true, separation: { jobId: 'job-old' } });
    expect(h.limiterCalls).toBe(0);
    expect(h.workflowCalls).toBe(0);
  });

  it('consumes only the dedicated limiter before creating a new separation job and workflow', async () => {
    const h = harness(null);
    const response = await h.app.request('/api/projects/p1/separation', { method: 'POST' }, h.env);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'queued', reused: false, jobId: 'job-new', workflowId: 'wf-1', separation: { id: 'sep-new', sourceRevision: 2 } });
    expect(h.limiterCalls).toBe(1);
    expect(h.createJobCalls).toBe(1);
    expect(h.createSeparationCalls).toBe(1);
    expect(h.workflowCalls).toBe(1);
  });

  it('requires explicit retry for failed identity and reuses the same separation identity when admitted', async () => {
    const failed = { ...completed, status: 'failed', completedAt: null, backgroundObjectKey: null, dialogueObjectKey: null, errorCode: 'SEPARATION_FAILED', errorMessage: 'safe failure' };
    const h = harness(failed);
    const denied = await h.app.request('/api/projects/p1/separation', { method: 'POST' }, h.env);
    expect(denied.status).toBe(409);
    expect(h.limiterCalls).toBe(0);
    const retried = await h.app.request('/api/projects/p1/separation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retry: true }) }, h.env);
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ status: 'retrying', reused: true, separation: { id: 'sep-1', jobId: 'job-old' } });
    expect(h.retryCalls).toBe(1);
    expect(h.limiterCalls).toBe(1);
    expect(h.workflowCalls).toBe(1);
    expect(h.createSeparationCalls).toBe(0);
  });

  it('returns safe current status and never exposes container or credential details', async () => {
    const h = harness(completed);
    const response = await h.app.request('/api/projects/p1/separation', {}, h.env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ status: 'completed', qualified: true, separation: { sourceRevision: 2, provider: 'demucs-container', modelId: 'htdemucs', jobId: 'job-old' } });
    expect(JSON.stringify(body)).not.toMatch(/SEPARATOR_CONTAINER|signed|token|credential|objectKey/i);
  });

  it('authorizes ownership before consuming the expensive-operation limiter', async () => {
    const h = harness(null);
    const response = await h.app.request('/api/projects/foreign/separation', { method: 'POST' }, h.env);
    expect(response.status).toBe(404);
    expect(h.limiterCalls).toBe(0);
    expect(h.workflowCalls).toBe(0);
  });
});
