import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createProcessRoutes } from '../src/routes/process';

const allowProcess = { async limit() { return { success: true }; } };
const analytics = { writeDataPoint() {} };

describe('zero-container process admission', () => {
  it('fails before job creation when the Stream binding is unavailable', async () => {
    let created = false;
    const project = {
      id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
      targetLanguage: 'vi' as const, targetLanguagesRevision: 1, status: 'ready' as const,
      sourceObjectKey: 'projects/project-1/source/movie.mp4',
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProcessRoutes({
      makeProjects: () => ({
        async getByIdForUser() { return project; },
        async setStatus() {},
      }) as never,
      makeJobs: () => ({
        async create() { created = true; throw new Error('job must not be created'); },
      }) as never,
    }));
    const env = {
      ANALYTICS: analytics,
      RATE_LIMIT_PROCESS: allowProcess,
      STREAM_SOURCE_SIGNING_SECRET: 'source-secret',
      DUBBING_WORKFLOW: { async create() { return { id: 'workflow-1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/process', { method: 'POST' }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'STREAM_BINDING_UNAVAILABLE' } });
    expect(created).toBe(false);
  });
});
