import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createProcessRoutes } from '../src/routes/process';

const allowProcess = { async limit() { return { success: true }; } };
const analytics = { writeDataPoint() {} };

function admissionApp(created: { value: boolean }) {
  const project = {
    id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
    targetLanguage: 'vi' as const, targetLanguagesRevision: 1, sourceGeneration: 1, status: 'ready' as const,
    sourceObjectKey: 'projects/project-1/source/movie.mp4',
  };
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createProcessRoutes({
    makeProjects: () => ({
      async getByIdForUser() { return project; },
      async setStatus() {},
    }) as never,
    makeJobs: () => ({
      async create() { created.value = true; throw new Error('job must not be created'); },
    }) as never,
  }));
  return app;
}

describe('zero-container process admission', () => {
  it('fails before job creation when the Stream binding is unavailable', async () => {
    const created = { value: false };
    const app = admissionApp(created);
    const env = {
      ANALYTICS: analytics,
      RATE_LIMIT_PROCESS: allowProcess,
      PUBLIC_ORIGIN: 'https://yupvox.qs3d.site',
      STREAM_SOURCE_SIGNING_SECRET: 'source-secret',
      DUBBING_WORKFLOW: { async create() { return { id: 'workflow-1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/process', { method: 'POST' }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: true, code: 'STREAM_BINDING_UNAVAILABLE' });
    expect(created.value).toBe(false);
  });

  it('fails before job creation when the signed Stream source origin is unavailable', async () => {
    const created = { value: false };
    const app = admissionApp(created);
    const env = {
      ANALYTICS: analytics,
      RATE_LIMIT_PROCESS: allowProcess,
      STREAM: {},
      STREAM_SOURCE_SIGNING_SECRET: 'source-secret',
      DUBBING_WORKFLOW: { async create() { return { id: 'workflow-1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/process', { method: 'POST' }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: true, code: 'STREAM_PUBLIC_ORIGIN_UNAVAILABLE' });
    expect(created.value).toBe(false);
  });
});
