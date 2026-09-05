import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';

describe('export route', () => {
  it('creates an export job and Workflow instance for an owned review-ready project', async () => {
    const workflowCalls: unknown[] = [];
    const project = {
      id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
      targetLanguage: 'vi' as const, status: 'needs_review' as const,
      sourceObjectKey: 'projects/project-1/source/movie.mp4',
    };
    const projects = {
      async getByIdForUser(id: string, userId: string) { return id === project.id && userId === project.userId ? project : null; },
      async setStatus() {},
    };
    const jobs = {
      async create(projectId: string, type: string) {
        expect(type).toBe('export');
        return { id: 'job-export-1', projectId, type, status: 'queued' as const, progress: 0, currentStep: null, errorCode: null, errorMessage: null };
      },
      async fail() {},
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => projects as never,
      makeJobs: () => jobs as never,
    }));
    const env = {
      ELEVENLABS_API_KEY: 'key',
      ELEVENLABS_DEFAULT_VOICE_ID: 'voice',
      EXPORT_WORKFLOW: {
        async create(input: unknown) { workflowCalls.push(input); return { id: 'workflow-export-1' }; },
      },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/export', { method: 'POST' }, env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: 'job-export-1', workflowId: 'workflow-export-1', status: 'queued' });
    expect(workflowCalls).toEqual([{ params: { projectId: 'project-1', userId: 'dev-user', jobId: 'job-export-1' } }]);
  });

  it('fails closed before creating a job when voice credentials are missing', async () => {
    let created = false;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() {
          return { id: 'p1', userId: 'dev-user', status: 'needs_review', sourceObjectKey: 'projects/p1/source/a.mp4' };
        },
      }) as never,
      makeJobs: () => ({ async create() { created = true; throw new Error('must not create'); } }) as never,
    }));

    const response = await app.request('/api/projects/p1/export', { method: 'POST' }, { EXPORT_WORKFLOW: { create: async () => ({ id: 'x' }) } } as unknown as Env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'VOICE_PROVIDER_UNCONFIGURED' });
    expect(created).toBe(false);
  });

  it('rejects projects that are not ready for review/export', async () => {
    let created = false;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() {
          return { id: 'p1', userId: 'dev-user', status: 'processing', sourceObjectKey: 'projects/p1/source/a.mp4' };
        },
      }) as never,
      makeJobs: () => ({ async create() { created = true; throw new Error('must not create'); } }) as never,
    }));
    const env = {
      ELEVENLABS_API_KEY: 'key', ELEVENLABS_DEFAULT_VOICE_ID: 'voice',
      EXPORT_WORKFLOW: { create: async () => ({ id: 'x' }) },
    } as unknown as Env;

    const response = await app.request('/api/projects/p1/export', { method: 'POST' }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PROJECT_NOT_EXPORTABLE' });
    expect(created).toBe(false);
  });
});
