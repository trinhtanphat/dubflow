import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';

const allowExport = { async limit() { return { success: true }; } };
const analytics = { writeDataPoint() {} };
const voiceCapabilities = { configured: true, languages: ['vi'] as const };

function baseDeps(calls: string[], workflowInputs: unknown[]) {
  return {
    makeProjects: () => ({
      async getByIdForUser() {
        return {
          id: 'project-1',
          userId: 'dev-user',
          status: 'needs_review' as const,
          sourceObjectKey: 'projects/project-1/source/movie.mp4',
          sourceRevision: 3,
        };
      },
      async setStatus() {},
    }) as never,
    makeLanguages: () => ({
      async getConfig() { return { revision: 0, languages: [{ targetLanguage: 'vi' as const }] }; },
    }) as never,
    makeSegments: () => ({ async list() { return [{ id: 'segment-1' }]; } }) as never,
    makeVariants: () => ({
      async list() {
        return [{ segmentId: 'segment-1', translationStatus: 'completed', translatedText: 'Xin chào' }];
      },
    }) as never,
    makeJobs: () => ({
      async create() { calls.push('job:create'); return { id: 'job-1' }; },
      async fail() {},
    }) as never,
    getVoiceCapabilities: () => voiceCapabilities as never,
    makeExports: () => ({
      async create(
        _projectId: string,
        _userId: string,
        _targetLanguage: string,
        _output: string,
        _batchId: string | null,
        mixMode?: string,
      ) {
        calls.push(`export:create:${mixMode ?? 'missing'}`);
        return { id: 'export-1', mixMode: mixMode ?? 'dubbed_only' };
      },
      async latest() { return null; },
      async latestCompleted() { return null; },
      async fail() {},
    }) as never,
    makeSeparations: () => ({
      async getCurrent() { calls.push('separation:getCurrent'); return null; },
    }) as never,
    getSeparationCapabilities: () => ({
      configured: true,
      qualified: true,
      provider: 'demucs-container',
      modelId: 'htdemucs',
      modelDigest: 'sha256:8726e21a',
    }),
    recordWorkflowInput(input: unknown) { workflowInputs.push(input); },
  };
}

function env(calls: string[], workflowInputs: unknown[]): Env {
  return {
    ANALYTICS: analytics,
    RATE_LIMIT_EXPORT: allowExport,
    EXPORT_WORKFLOW: {
      async create(input: unknown) {
        calls.push('workflow:create');
        workflowInputs.push(input);
        return { id: 'workflow-1' };
      },
    },
  } as unknown as Env;
}

describe('Phase 4D export mix route contract', () => {
  it('fails closed for preserve_background when no current completed separation exists and never starts export work', async () => {
    const calls: string[] = [];
    const workflowInputs: unknown[] = [];
    const deps = baseDeps(calls, workflowInputs);
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes(deps as never));

    const response = await app.request('/api/projects/project-1/exports/vi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: 'dubbed', mixMode: 'preserve_background' }),
    }, env(calls, workflowInputs));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SEPARATION_UNAVAILABLE' });
    expect(calls).toEqual(['separation:getCurrent']);
    expect(workflowInputs).toEqual([]);
  });

  it('resolves an omitted mixMode to dubbed_only for persistence and workflow provenance', async () => {
    const calls: string[] = [];
    const workflowInputs: unknown[] = [];
    const deps = baseDeps(calls, workflowInputs);
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes(deps as never));

    const response = await app.request('/api/projects/project-1/exports/vi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: 'dubbed' }),
    }, env(calls, workflowInputs));

    expect(response.status).toBe(202);
    expect(calls).toContain('export:create:dubbed_only');
    expect(workflowInputs).toEqual([{ params: {
      projectId: 'project-1',
      userId: 'dev-user',
      jobId: 'job-1',
      exportId: 'export-1',
      targetLanguage: 'vi',
      output: 'dubbed',
      mixMode: 'dubbed_only',
      requestId: undefined,
    } }]);
  });
});
