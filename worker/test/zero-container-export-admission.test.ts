import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';

const allowExport = { async limit() { return { success: true }; } };
const analytics = { writeDataPoint() {} };

describe('zero-container export admission', () => {
  it('rejects dubbed export before durable mutation when Stream write configuration is unavailable', async () => {
    const calls: string[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() {
          return { id: 'p1', userId: 'dev-user', status: 'needs_review', sourceObjectKey: 'projects/p1/source/a.mp4' };
        },
        async setStatus() { calls.push('project:setStatus'); },
      }) as never,
      makeJobs: () => ({ async create() { calls.push('job:create'); return { id: 'j1' }; } }) as never,
      makeLanguages: () => ({ async getConfig() { return { revision: 1, languages: [{ targetLanguage: 'vi' }] }; } }) as never,
      makeSegments: () => ({ async list() { return [{ id: 's1' }]; } }) as never,
      makeVariants: () => ({
        async list() { return [{ segmentId: 's1', targetLanguage: 'vi', translationStatus: 'completed', translatedText: 'Xin chào' }]; },
      }) as never,
      makeExports: () => ({
        async create() { calls.push('export:create'); return { id: 'e1' }; },
        async latest() { return null; },
        async latestCompleted() { return null; },
        async fail() {},
      }) as never,
    }));

    const response = await app.request('/api/projects/p1/exports/vi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: 'dubbed' }),
    }, {
      ANALYTICS: analytics,
      RATE_LIMIT_EXPORT: allowExport,
      ELEVENLABS_API_KEY: 'voice-key',
      ELEVENLABS_DEFAULT_VOICE_ID: 'voice-id',
      STREAM_SOURCE_SIGNING_SECRET: 'source-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      EXPORT_WORKFLOW: { async create() { calls.push('workflow:create'); return { id: 'wf1' }; } },
    } as unknown as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: true, code: 'STREAM_BINDING_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it('does not require Stream write configuration for subtitle-only export', async () => {
    const calls: string[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() { return { id: 'p1', userId: 'dev-user', status: 'needs_review' }; },
      }) as never,
      makeJobs: () => ({ async create() { calls.push('job:create'); return { id: 'j1' }; } }) as never,
      makeLanguages: () => ({ async getConfig() { return { revision: 1, languages: [{ targetLanguage: 'vi' }] }; } }) as never,
      makeSegments: () => ({ async list() { return [{ id: 's1' }]; } }) as never,
      makeVariants: () => ({
        async list() { return [{ segmentId: 's1', targetLanguage: 'vi', translationStatus: 'completed', translatedText: 'Xin chào' }]; },
      }) as never,
      makeExports: () => ({
        async create() { calls.push('export:create'); return { id: 'e1' }; },
        async latest() { return null; },
        async latestCompleted() { return null; },
        async fail() {},
      }) as never,
    }));

    const response = await app.request('/api/projects/p1/exports/vi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: 'subtitles' }),
    }, {
      ANALYTICS: analytics,
      RATE_LIMIT_EXPORT: allowExport,
      EXPORT_WORKFLOW: { async create() { calls.push('workflow:create'); return { id: 'wf1' }; } },
    } as unknown as Env);

    expect(response.status).toBe(202);
    expect(calls).toEqual(['export:create', 'job:create', 'workflow:create']);
  });
});
