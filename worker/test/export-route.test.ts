import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';

describe('export route', () => {
  it('locks the project before creating the Workflow instance for an owned review-ready project', async () => {
    const calls: string[] = [];
    const workflowCalls: unknown[] = [];
    const project = {
      id: 'project-1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'zh' as const,
      targetLanguage: 'vi' as const, status: 'needs_review' as const,
      sourceObjectKey: 'projects/project-1/source/movie.mp4',
    };
    const projects = {
      async getByIdForUser(id: string, userId: string) { return id === project.id && userId === project.userId ? project : null; },
      async setStatus(_id: string, _userId: string, status: string) { calls.push(`project:${status}`); },
    };
    const jobs = {
      async create(projectId: string, type: string) {
        expect(type).toBe('export');
        calls.push('job:create');
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
        async create(input: unknown) { calls.push('workflow:create'); workflowCalls.push(input); return { id: 'workflow-export-1' }; },
      },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/export', { method: 'POST' }, env);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ jobId: 'job-export-1', workflowId: 'workflow-export-1', status: 'queued' });
    expect(workflowCalls).toEqual([{ params: { projectId: 'project-1', userId: 'dev-user', jobId: 'job-export-1' } }]);
    expect(calls).toEqual(['job:create', 'project:processing', 'workflow:create']);
  });

  it('restores needs_review and fails the durable job when Workflow start fails after locking', async () => {
    const calls: string[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() { return { id: 'p1', userId: 'dev-user', status: 'needs_review', sourceObjectKey: 'projects/p1/source/a.mp4' }; },
        async setStatus(_id: string, _userId: string, status: string) { calls.push(`project:${status}`); },
      }) as never,
      makeJobs: () => ({
        async create() { calls.push('job:create'); return { id: 'j1' }; },
        async fail(_id: string, code: string) { calls.push(`job:fail:${code}`); },
      }) as never,
    }));
    const env = {
      ELEVENLABS_API_KEY: 'key', ELEVENLABS_DEFAULT_VOICE_ID: 'voice',
      EXPORT_WORKFLOW: { async create() { calls.push('workflow:create'); throw new Error('workflow unavailable'); } },
    } as unknown as Env;

    const response = await app.request('/api/projects/p1/export', { method: 'POST' }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'EXPORT_WORKFLOW_START_FAILED' });
    expect(calls).toEqual([
      'job:create',
      'project:processing',
      'workflow:create',
      'job:fail:EXPORT_WORKFLOW_START_FAILED',
      'project:needs_review',
    ]);
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
