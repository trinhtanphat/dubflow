import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createProcessRoutes } from '../src/routes/process';
import { createExportRoutes } from '../src/routes/export';

function analytics() {
  return { writeDataPoint() {} } as Env['ANALYTICS'];
}

function rejectedLimiter(calls: string[]) {
  return {
    async limit({ key }: { key: string }) {
      calls.push(`limit:${key}`);
      return { success: false };
    },
  } as Env['RATE_LIMIT_PROCESS'];
}

describe('Phase 3C expensive route admission', () => {
  it('rejects process before durable job or Workflow creation', async () => {
    const calls: string[] = [];
    const project = {
      id: 'p1', userId: 'dev-user', status: 'ready', sourceObjectKey: 'projects/p1/source/a.mp4',
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProcessRoutes({
      makeProjects: () => ({
        async getByIdForUser() { calls.push('project:get'); return project; },
        async setStatus() { calls.push('project:set'); },
      }) as never,
      makeJobs: () => ({
        async create() { calls.push('job:create'); return { id: 'j1' }; },
      }) as never,
    }));
    const env = {
      ANALYTICS: analytics(),
      RATE_LIMIT_PROCESS: rejectedLimiter(calls),
      DUBBING_WORKFLOW: { async create() { calls.push('workflow:create'); return { id: 'w1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/p1/process', { method: 'POST' }, env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toEqual(['project:get', 'limit:dev-user:process']);
  });

  it('does not consume process budget for a foreign project', async () => {
    const calls: string[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProcessRoutes({
      makeProjects: () => ({ async getByIdForUser() { calls.push('project:get'); return null; } }) as never,
      makeJobs: () => ({ async create() { calls.push('job:create'); return { id: 'j1' }; } }) as never,
    }));
    const env = {
      ANALYTICS: analytics(),
      RATE_LIMIT_PROCESS: rejectedLimiter(calls),
      DUBBING_WORKFLOW: { async create() { calls.push('workflow:create'); return { id: 'w1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/foreign/process', { method: 'POST' }, env);
    expect(response.status).toBe(404);
    expect(calls).toEqual(['project:get']);
  });

  it('rejects export before job creation, project mutation, or Workflow creation', async () => {
    const calls: string[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() {
          calls.push('project:get');
          return { id: 'p1', userId: 'dev-user', status: 'needs_review', sourceObjectKey: 'projects/p1/source/a.mp4' };
        },
        async setStatus() { calls.push('project:set'); },
      }) as never,
      makeJobs: () => ({
        async create() { calls.push('job:create'); return { id: 'j1' }; },
        async fail() { calls.push('job:fail'); },
      }) as never,
    }));
    const limiter = rejectedLimiter(calls);
    const env = {
      ANALYTICS: analytics(),
      RATE_LIMIT_EXPORT: limiter,
      ELEVENLABS_API_KEY: 'key',
      ELEVENLABS_DEFAULT_VOICE_ID: 'voice',
      EXPORT_WORKFLOW: { async create() { calls.push('workflow:create'); return { id: 'w1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/p1/export', { method: 'POST' }, env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toEqual(['project:get', 'limit:dev-user:export']);
  });
});
