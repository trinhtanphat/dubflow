import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createProcessRoutes } from '../src/routes/process';

const allowProcess = { async limit() { return { success: true }; } };
const analytics = { writeDataPoint() {} };

function projectFixture() {
  return {
    id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
    targetLanguage: 'vi' as const, targetLanguagesRevision: 1, status: 'ready' as const,
    sourceObjectKey: 'projects/project-1/source/movie.mp4',
  };
}

function appWithJobGuard(onCreate: () => void) {
  const project = projectFixture();
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createProcessRoutes({
    makeProjects: () => ({
      async getByIdForUser() { return project; },
      async setStatus() {},
    }) as never,
    makeJobs: () => ({
      async create() { onCreate(); throw new Error('job must not be created'); },
    }) as never,
  }));
  return app;
}

describe('R2-only process admission', () => {
  it('fails before job creation when the MEDIA R2 binding is unavailable', async () => {
    let created = false;
    const app = appWithJobGuard(() => { created = true; });
    const env = {
      ANALYTICS: analytics,
      RATE_LIMIT_PROCESS: allowProcess,
      MEDIA_SOURCE_SIGNING_SECRET: 'source-secret',
      PUBLIC_ORIGIN: 'https://yupvox.qs3d.site',
      DUBBING_WORKFLOW: { async create() { return { id: 'workflow-1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/process', { method: 'POST' }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: true, code: 'MEDIA_SOURCE_UNAVAILABLE' });
    expect(created).toBe(false);
  });

  it('fails before job creation when the signed R2 source origin is unavailable', async () => {
    let created = false;
    const app = appWithJobGuard(() => { created = true; });
    const env = {
      ANALYTICS: analytics,
      RATE_LIMIT_PROCESS: allowProcess,
      MEDIA: {},
      MEDIA_SOURCE_SIGNING_SECRET: 'source-secret',
      DUBBING_WORKFLOW: { async create() { return { id: 'workflow-1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/process', { method: 'POST' }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: true, code: 'MEDIA_SOURCE_ORIGIN_UNAVAILABLE' });
    expect(created).toBe(false);
  });

  it('fails closed when only the retired Stream signing-secret alias is present', async () => {
    let created = false;
    const app = appWithJobGuard(() => { created = true; });
    const env = {
      ANALYTICS: analytics,
      RATE_LIMIT_PROCESS: allowProcess,
      MEDIA: {},
      STREAM_SOURCE_SIGNING_SECRET: 'legacy-source-secret',
      PUBLIC_ORIGIN: 'https://yupvox.qs3d.site',
      DUBBING_WORKFLOW: { async create() { return { id: 'workflow-1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/process', { method: 'POST' }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: true, code: 'MEDIA_SOURCE_SIGNING_UNAVAILABLE' });
    expect(created).toBe(false);
  });
});
