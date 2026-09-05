import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createProcessRoutes } from '../src/routes/process';

describe('process route', () => {
  it('creates a dubbing job and Workflow instance for an owned ready project', async () => {
    const workflowCalls: unknown[] = [];
    const project = {
      id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
      targetLanguage: 'vi' as const, status: 'ready' as const, sourceObjectKey: 'projects/project-1/source/movie.mp4',
    };
    const projects = {
      async getByIdForUser(id: string, userId: string) { return id === project.id && userId === project.userId ? project : null; },
      async setStatus() {},
    };
    const jobs = {
      async create(projectId: string, type: string) {
        return { id: 'job-1', projectId, type, status: 'queued' as const, progress: 0, currentStep: null, errorCode: null, errorMessage: null };
      },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProcessRoutes({
      makeProjects: () => projects as never,
      makeJobs: () => jobs as never,
    }));
    const env = {
      DUBBING_WORKFLOW: {
        async create(input: unknown) { workflowCalls.push(input); return { id: 'workflow-1' }; },
      },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/process', { method: 'POST' }, env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: 'job-1', workflowId: 'workflow-1', status: 'queued' });
    expect(workflowCalls).toEqual([{ params: { projectId: 'project-1', userId: 'dev-user', jobId: 'job-1' } }]);
  });

  it('returns 404 without creating a job for a foreign project', async () => {
    let created = false;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProcessRoutes({
      makeProjects: () => ({ async getByIdForUser() { return null; } }) as never,
      makeJobs: () => ({ async create() { created = true; throw new Error('must not create'); } }) as never,
    }));
    const response = await app.request('/api/projects/foreign/process', { method: 'POST' }, { DUBBING_WORKFLOW: { create: async () => ({ id: 'x' }) } } as unknown as Env);
    expect(response.status).toBe(404);
    expect(created).toBe(false);
  });
});
