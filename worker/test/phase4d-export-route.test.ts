import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';

function harness(options: { separationAvailable?: boolean } = {}) {
  const calls = { exports: 0, jobs: 0, workflow: [] as any[] };
  const project = {
    id: 'project-1', userId: 'dev-user', title: 'Demo', sourceLanguage: 'en' as const,
    targetLanguage: 'vi' as const, targetLanguagesRevision: 1, status: 'needs_review' as const,
    sourceObjectKey: 'projects/project-1/source/movie.mp4', exportObjectKey: null,
  };
  const deps = {
    makeProjects: () => ({
      async getByIdForUser(id: string, userId: string) {
        return id === project.id && userId === project.userId ? project : null;
      },
      async setStatus() {},
    }) as never,
    makeLanguages: () => ({
      async getConfig() { return { revision: 1, languages: [{ targetLanguage: 'vi' as const }] }; },
    }) as never,
    makeSegments: () => ({
      async list() { return [{ id: 's1' }]; },
    }) as never,
    makeVariants: () => ({
      async list() {
        return [{ segmentId: 's1', translationStatus: 'completed', translatedText: 'Xin chào' }];
      },
    }) as never,
    makeExports: () => ({
      async create() { calls.exports += 1; return { id: 'export-1' }; },
      async latest() { return null; },
      async latestCompleted() { return null; },
      async fail() {},
    }) as never,
    makeJobs: () => ({
      async create() { calls.jobs += 1; return { id: 'job-1' }; },
      async fail() {},
    }) as never,
    getVoiceCapabilities: () => ({
      provider: 'elevenlabs', configured: true, languages: ['vi'], cloning: false, preview: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
    }) as never,
  };
  const env = {
    ELEVENLABS_API_KEY: 'provider-key',
    FFMPEG_CONTAINER: options.separationAvailable === false ? undefined : { getByName() { return {}; } },
    ANALYTICS: { writeDataPoint() {} },
    RATE_LIMIT_EXPORT: { async limit() { return { success: true }; } },
    EXPORT_WORKFLOW: {
      async create(input: any) { calls.workflow.push(input); return { id: 'workflow-1' }; },
    },
  } as unknown as Env;
  return { calls, deps, env };
}

async function request(
  h: ReturnType<typeof harness>,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  const routes = createExportRoutes(h.deps);
  return routes.fetch(new Request(`https://yupvox.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), h.env);
}

describe('Phase 4D export admission', () => {
  it('defaults dubbed export to source_mix and passes the normalized mode into Workflow params', async () => {
    const h = harness();
    const response = await request(h, '/project-1/exports/vi', 'POST', { output: 'dubbed' });
    expect(response.status).toBe(202);
    expect(h.calls.workflow[0]?.params).toMatchObject({ separationMode: 'source_mix' });
  });

  it('passes preserve_background only when the deployment has both provider and media capability', async () => {
    const h = harness();
    const response = await request(h, '/project-1/exports/vi', 'POST', {
      output: 'dubbed', separationMode: 'preserve_background',
    });
    expect(response.status).toBe(202);
    expect(h.calls.workflow[0]?.params).toMatchObject({ separationMode: 'preserve_background' });
  });

  it('fails closed before export/job creation when preserve_background capability is absent', async () => {
    const h = harness({ separationAvailable: false });
    const response = await request(h, '/project-1/exports/vi', 'POST', {
      output: 'dubbed', separationMode: 'preserve_background',
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'STEM_SEPARATION_UNAVAILABLE' });
    expect(h.calls.exports).toBe(0);
    expect(h.calls.jobs).toBe(0);
    expect(h.calls.workflow).toHaveLength(0);
  });

  it('rejects invalid separation modes and preserve_background subtitle requests', async () => {
    const h = harness();
    const invalid = await request(h, '/project-1/exports/vi', 'POST', {
      output: 'dubbed', separationMode: 'magic',
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'STEM_SEPARATION_MODE_INVALID' });

    const subtitles = await request(h, '/project-1/exports/vi', 'POST', {
      output: 'subtitles', separationMode: 'preserve_background',
    });
    expect(subtitles.status).toBe(400);
    await expect(subtitles.json()).resolves.toMatchObject({ code: 'STEM_SEPARATION_OUTPUT_INVALID' });
  });

  it('reports separation capability without exposing credentials', async () => {
    const available = harness();
    const response = await request(available, '/project-1/export-capabilities');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      dialogueBackgroundSeparation: {
        available: true,
        modes: ['source_mix', 'preserve_background'],
      },
    });

    const unavailable = harness({ separationAvailable: false });
    const unavailableResponse = await request(unavailable, '/project-1/export-capabilities');
    await expect(unavailableResponse.json()).resolves.toEqual({
      dialogueBackgroundSeparation: {
        available: false,
        modes: ['source_mix'],
      },
    });
  });
});
