import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';

function harness(syncApiKey?: string, qualified = false) {
  const calls = {
    rateLimits: 0,
    exports: [] as Array<{ lipSyncRequested: boolean }>,
    jobs: 0,
    workflows: [] as Array<{ params?: Record<string, unknown> }>,
  };
  const project = {
    id: 'p1', userId: 'dev-user', title: 'Demo', sourceLanguage: 'en', targetLanguage: 'vi',
    targetLanguagesRevision: 1, status: 'needs_review', sourceObjectKey: 'projects/p1/source/input.mp4',
    sourceGeneration: 1, exportObjectKey: null,
  };
  const projects = {
    async getByIdForUser(id: string, userId: string) { return id === 'p1' && userId === 'dev-user' ? project : null; },
    async setStatus() {},
  };
  const languages = {
    async getConfig() { return { revision: 1, languages: [{ targetLanguage: 'vi', status: 'needs_review' }] }; },
  };
  const segments = {
    async list() {
      return [{
        id: 's1', projectId: 'p1', sourceText: 'Hello', speakerId: null, startMs: 0, endMs: 1000,
        translatedText: '', translationEngine: 'workers-ai', translationContextRevision: 1,
        translationStatus: 'completed', voiceStatus: 'pending', dubbedObjectKey: null, version: 1, splitParentId: null,
      }];
    },
  };
  const variants = {
    async list() {
      return [{
        segmentId: 's1', projectId: 'p1', targetLanguage: 'vi', translatedText: 'Xin chào',
        translationEngine: 'workers-ai', translationStatus: 'completed', translationContextRevision: 1,
        voiceStatus: 'pending', dubbedObjectKey: null, version: 1,
      }];
    },
  };
  const exportsStore = {
    async create(
      _projectId: string,
      _userId: string,
      _targetLanguage: string,
      _output: string,
      _batchId: string | null,
      _audioMode: string,
      lipSyncRequested = false,
    ) {
      calls.exports.push({ lipSyncRequested });
      return {
        id: `e${calls.exports.length}`, projectId: 'p1', targetLanguage: 'vi', output: 'dubbed', batchId: null,
        audioMode: 'dubbed_only', status: 'pending', exportObjectKey: null, subtitleObjectKey: null,
        lipSyncRequested, lipSyncProvider: null, lipSyncStatus: lipSyncRequested ? 'queued' : 'not_requested',
        lipSyncObjectKey: null, errorCode: null, errorMessage: null,
      };
    },
    async latest() { return null; },
    async latestCompleted() { return null; },
    async fail() {},
  };
  const jobs = {
    async create() { calls.jobs += 1; return { id: `j${calls.jobs}` }; },
    async fail() {},
  };
  const limiter = {
    async limit() { calls.rateLimits += 1; return { success: true }; },
  };
  const env = {
    SYNC_API_KEY: syncApiKey,
    SYNC_LIPSYNC_QUALIFIED: qualified ? 'true' : undefined,
    MEDIA: {},
    RATE_LIMIT_EXPORT: limiter,
    RATE_LIMIT_BATCH_EXPORT: limiter,
    ANALYTICS: { writeDataPoint() {} },
    EXPORT_WORKFLOW: {
      async create(input: { params?: Record<string, unknown> }) {
        calls.workflows.push(input);
        return { id: `w${calls.workflows.length}` };
      },
    },
  } as unknown as Env;
  const deps = {
    makeProjects: () => projects,
    makeLanguages: () => languages,
    makeSegments: () => segments,
    makeVariants: () => variants,
    makeExports: () => exportsStore,
    makeJobs: () => jobs,
    getVoiceCapabilities: () => ({
      provider: 'elevenlabs', configured: true, languages: ['vi'], cloning: false, preview: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
    }),
    makeSeparation: () => ({
      async capabilities() {
        return { configured: false, provider: null, backgroundStem: false, dialogueStem: false, qualification: 'unavailable' };
      },
      async separate() { throw new Error('not used'); },
    }),
  };
  return { calls, env, deps };
}

async function post(h: ReturnType<typeof harness>, body: unknown) {
  const { createExportRoutes } = await import('../src/routes/export');
  const routes = createExportRoutes(h.deps as never);
  return routes.fetch(new Request('https://yupvox.test/p1/exports/vi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), h.env);
}

describe('Phase 4E visual lip-sync export admission', () => {
  it('defaults dubbed export to standard and persists no lip-sync request', async () => {
    const h = harness();
    const response = await post(h, { output: 'dubbed' });
    expect(response.status).toBe(202);
    expect(h.calls.exports).toEqual([{ lipSyncRequested: false }]);
    expect(h.calls.workflows[0]?.params).toMatchObject({ visualMode: 'standard' });
    await expect(response.json()).resolves.toMatchObject({ visualMode: 'standard' });
  });

  it('admits explicit lip_sync only when Sync is both configured and runtime-qualified', async () => {
    const h = harness('sync-key', true);
    const response = await post(h, { output: 'dubbed', visualMode: 'lip_sync' });
    expect(response.status).toBe(202);
    expect(h.calls.exports).toEqual([{ lipSyncRequested: true }]);
    expect(h.calls.workflows[0]?.params).toMatchObject({ visualMode: 'lip_sync' });
    await expect(response.json()).resolves.toMatchObject({ visualMode: 'lip_sync' });
  });

  it('rejects invalid visual mode before rate limiting or durable side effects', async () => {
    const h = harness('sync-key', true);
    const response = await post(h, { output: 'dubbed', visualMode: 'cinematic' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'VISUAL_MODE_INVALID' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exports).toHaveLength(0);
    expect(h.calls.jobs).toBe(0);
    expect(h.calls.workflows).toHaveLength(0);
  });

  it('rejects subtitle lip_sync before rate limiting or durable side effects', async () => {
    const h = harness('sync-key', true);
    const response = await post(h, { output: 'subtitles', visualMode: 'lip_sync' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'VISUAL_MODE_INVALID' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exports).toHaveLength(0);
    expect(h.calls.jobs).toBe(0);
  });

  it('fails closed without Sync key before rate limit, export row, job, or Workflow', async () => {
    const h = harness();
    const response = await post(h, { output: 'dubbed', visualMode: 'lip_sync' });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'LIP_SYNC_UNAVAILABLE' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exports).toHaveLength(0);
    expect(h.calls.jobs).toBe(0);
    expect(h.calls.workflows).toHaveLength(0);
  });

  it('fails closed with a configured but unqualified Sync provider before side effects', async () => {
    const h = harness('sync-key', false);
    const response = await post(h, { output: 'dubbed', visualMode: 'lip_sync' });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'LIP_SYNC_UNAVAILABLE' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exports).toHaveLength(0);
    expect(h.calls.jobs).toBe(0);
    expect(h.calls.workflows).toHaveLength(0);
  });

  it('exposes unavailable, unqualified, and qualified capability states without secrets', async () => {
    const { createExportRoutes } = await import('../src/routes/export');

    const unavailable = harness();
    const unavailableRoutes = createExportRoutes(unavailable.deps as never);
    const unavailableResponse = await unavailableRoutes.fetch(
      new Request('https://yupvox.test/p1/export-capabilities'), unavailable.env,
    );
    await expect(unavailableResponse.json()).resolves.toMatchObject({
      visualLipSync: { available: false, provider: null, qualification: 'unavailable' },
    });

    const unqualified = harness('sync-key', false);
    const unqualifiedRoutes = createExportRoutes(unqualified.deps as never);
    const unqualifiedResponse = await unqualifiedRoutes.fetch(
      new Request('https://yupvox.test/p1/export-capabilities'), unqualified.env,
    );
    await expect(unqualifiedResponse.json()).resolves.toMatchObject({
      visualLipSync: { available: false, provider: 'sync-labs', qualification: 'unqualified' },
    });

    const qualified = harness('sync-key', true);
    const qualifiedRoutes = createExportRoutes(qualified.deps as never);
    const qualifiedResponse = await qualifiedRoutes.fetch(
      new Request('https://yupvox.test/p1/export-capabilities'), qualified.env,
    );
    const body = await qualifiedResponse.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      visualLipSync: { available: true, provider: 'sync-labs', qualification: 'qualified' },
    });
    expect(JSON.stringify(body)).not.toContain('sync-key');
  });
});
