import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';
import { runExportPipeline } from '../src/workflows/exportPipeline';

const allowExport = { async limit() { return { success: true }; } };
const analytics = { writeDataPoint() {} };
const directStep = { async do<T>(_name: string, callback: () => Promise<T>) { return callback(); } };

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

  it('rejects unsupported source video before TTS or soundtrack work begins', async () => {
    const voiceGenerate = vi.fn(async () => {
      throw new Error('TTS_SHOULD_NOT_RUN');
    });
    const storeSoundtrack = vi.fn(async () => 'projects/p1/soundtracks/vi/legacy.wav');
    const inspect = vi.fn(async () => {
      throw new Error('VIDEO_TRANSCODE_REQUIRED: Source video codec vp9 requires transcoding.');
    });
    const deps = {
      projects: {
        getByIdForUser: vi.fn(async () => ({
          id: 'p1', sourceObjectKey: 'projects/p1/source/video.webm', durationMs: 10_000,
        })),
        setStatus: vi.fn(async () => {}),
        setExportObject: vi.fn(async () => {}),
      },
      jobs: {
        getForProject: vi.fn(async () => ({ status: 'running', retryCount: 0 })),
        setProgress: vi.fn(async () => {}),
        fail: vi.fn(async () => {}),
        complete: vi.fn(async () => {}),
      },
      segments: {
        list: vi.fn(async () => [{
          id: 's1', speakerId: null, startMs: 0, endMs: 1000,
          translatedText: 'Xin chào', voiceStatus: 'pending', dubbedObjectKey: null, version: 1,
        }]),
        setVoiceResult: vi.fn(async () => {}),
      },
      bucket: { put: vi.fn(async () => ({})) },
      voice: { generate: voiceGenerate },
      soundtrack: {
        durationSeconds: vi.fn(async () => 1),
        storeSoundtrack,
      },
      publisher: {
        inspect,
        publishDubbedExport: vi.fn(async () => ({ exportObjectKey: 'projects/p1/export/dubbed.mp4' })),
      },
      usage: {
        record: vi.fn(async () => ({})),
        getByOperation: vi.fn(async () => null),
      },
      telemetry: { write: vi.fn(async () => {}) },
    };

    await expect(runExportPipeline(
      { projectId: 'p1', userId: 'dev-user', jobId: 'j1' },
      deps as never,
      directStep as never,
    )).rejects.toThrow(/VIDEO_TRANSCODE_REQUIRED/);

    expect(inspect).toHaveBeenCalledWith('projects/p1/source/video.webm');
    expect(voiceGenerate).not.toHaveBeenCalled();
    expect(storeSoundtrack).not.toHaveBeenCalled();
  });
});
