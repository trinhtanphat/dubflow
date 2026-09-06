import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createProcessRoutes } from '../src/routes/process';
import { createExportRoutes } from '../src/routes/export';
import { createUploadRoutes } from '../src/routes/uploads';
import { UploadServiceError } from '../src/services/uploads';

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

function phase4cExportValidationDeps() {
  return {
    makeLanguages: () => ({
      async getConfig() {
        return { revision: 0, languages: [{ targetLanguage: 'vi' as const }] };
      },
    }) as never,
    makeSegments: () => ({
      async list() { return [{ id: 'segment-1' }]; },
    }) as never,
    makeVariants: () => ({
      async list() {
        return [{ segmentId: 'segment-1', translationStatus: 'completed', translatedText: 'Xin chào' }];
      },
    }) as never,
    makeExports: () => ({
      async create() { throw new Error('must not create an export attempt after rate limiting'); },
      async latest() { return null; },
      async fail() { throw new Error('must not fail a nonexistent export attempt'); },
    }) as never,
  };
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

  it('rejects export after owner/variant validation but before durable export/job/project mutation/Workflow creation', async () => {
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
      ...phase4cExportValidationDeps(),
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
    expect(calls).toEqual(['project:get', 'project:get', 'limit:dev-user:export']);
  });

  it('uses the dedicated batch-export limiter after target validation and before durable fan-out', async () => {
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
      ...phase4cExportValidationDeps(),
    }));
    const env = {
      ANALYTICS: analytics(),
      RATE_LIMIT_BATCH_EXPORT: rejectedLimiter(calls),
      EXPORT_WORKFLOW: { async create() { calls.push('workflow:create'); return { id: 'w1' }; } },
    } as unknown as Env;

    const response = await app.request('/api/projects/p1/exports/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetLanguages: ['vi'], output: 'subtitles' }),
    }, env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toEqual(['project:get', 'limit:dev-user:batch-export']);
  });

  it('rejects upload session after authorization and validation but before multipart creation', async () => {
    const calls: string[] = [];
    const service = {
      async validateBegin() {
        calls.push('upload:validate');
        return { filename: 'movie.mp4', sizeBytes: 1000, contentType: 'video/mp4', extension: 'mp4' as const };
      },
      async beginValidated() {
        calls.push('multipart:create');
        return { uploadId: 'u1', objectKey: 'projects/p1/source/a.mp4', partSizeBytes: 1 };
      },
      async uploadPart() { throw new Error('unused'); },
      async complete() { throw new Error('unused'); },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createUploadRoutes({ makeService: () => service as never } as never));
    const env = {
      ANALYTICS: analytics(),
      RATE_LIMIT_UPLOAD: rejectedLimiter(calls),
    } as unknown as Env;

    const response = await app.request('/api/projects/p1/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'movie.mp4', sizeBytes: 1000, contentType: 'video/mp4' }),
    }, env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toEqual(['upload:validate', 'limit:dev-user:upload']);
  });

  it('does not consume upload budget when ownership/validation fails', async () => {
    const calls: string[] = [];
    const service = {
      async validateBegin() {
        calls.push('upload:validate');
        throw new UploadServiceError('PROJECT_NOT_FOUND', 'Project not found.');
      },
      async beginValidated() { calls.push('multipart:create'); throw new Error('must not create'); },
      async uploadPart() { throw new Error('unused'); },
      async complete() { throw new Error('unused'); },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createUploadRoutes({ makeService: () => service as never } as never));
    const env = {
      ANALYTICS: analytics(),
      RATE_LIMIT_UPLOAD: rejectedLimiter(calls),
    } as unknown as Env;

    const response = await app.request('/api/projects/foreign/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'movie.mp4', sizeBytes: 1000, contentType: 'video/mp4' }),
    }, env);

    expect(response.status).toBe(404);
    expect(calls).toEqual(['upload:validate']);
  });
});
