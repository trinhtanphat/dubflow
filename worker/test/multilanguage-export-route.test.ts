import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { ExportOutput, TargetLanguage } from '../src/domain/language';
import type { VoiceCapabilities } from '../src/services/voice/types';

const project = {
  id: 'project-1', userId: 'dev-user', title: 'Demo', sourceLanguage: 'en', targetLanguage: 'vi',
  targetLanguagesRevision: 3, status: 'needs_review', sourceObjectKey: 'projects/project-1/source.mp4',
  exportObjectKey: null,
};

const sourceSegments = [
  { id: 'segment-1', sourceText: 'Hello' },
  { id: 'segment-2', sourceText: 'World' },
];

function capabilities(languages: string[] | 'unknown'): VoiceCapabilities {
  return {
    provider: 'elevenlabs',
    configured: true,
    languages,
    cloning: false,
    preview: true,
    cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
  };
}

function harness(options: { voiceLanguages?: string[] | 'unknown'; failWorkflowTarget?: TargetLanguage } = {}) {
  const calls = {
    rateLimits: 0,
    exportCreates: [] as Array<{ target: TargetLanguage; output: ExportOutput; batchId: string | null; id: string }>,
    exportFailures: [] as Array<{ id: string; code: string }>,
    workflow: [] as Array<{ params?: any }>,
    jobs: [] as string[],
    projectStatuses: [] as string[],
  };
  let nextExport = 1;
  let nextJob = 1;

  const projects = {
    async getByIdForUser(id: string, userId: string) {
      return id === 'project-1' && userId === 'dev-user' ? project : null;
    },
    async setStatus(_id: string, _userId: string, status: string) {
      calls.projectStatuses.push(status);
    },
  };
  const languages = {
    async getConfig(id: string, userId: string) {
      return id === 'project-1' && userId === 'dev-user'
        ? { revision: 3, languages: [
          { targetLanguage: 'vi', status: 'needs_review' },
          { targetLanguage: 'ja', status: 'needs_review' },
          { targetLanguage: 'ko', status: 'needs_review' },
        ] }
        : null;
    },
  };
  const segments = {
    async list() {
      return sourceSegments.map((row, index) => ({
        ...row,
        projectId: 'project-1', speakerId: null, startMs: index * 1000, endMs: (index + 1) * 1000,
        translatedText: '', translationEngine: 'workers-ai', translationContextRevision: 1,
        translationStatus: 'completed', voiceStatus: 'pending', dubbedObjectKey: null,
        version: 1, splitParentId: null,
      }));
    },
  };
  const variants = {
    async list(_projectId: string, _userId: string, target: TargetLanguage) {
      return sourceSegments.map((row) => ({
        segmentId: row.id, projectId: 'project-1', targetLanguage: target,
        translatedText: `${target}:${row.sourceText}`, translationEngine: 'workers-ai',
        translationStatus: 'completed', translationContextRevision: 7, voiceStatus: 'pending',
        dubbedObjectKey: null, version: 2,
      }));
    },
  };
  const exportsStore = {
    async create(_projectId: string, _userId: string, target: TargetLanguage, output: ExportOutput, batchId: string | null = null) {
      const id = `export-${nextExport++}`;
      calls.exportCreates.push({ target, output, batchId, id });
      return {
        id, projectId: 'project-1', targetLanguage: target, output, batchId, status: 'pending',
        exportObjectKey: null, subtitleObjectKey: null, errorCode: null, errorMessage: null,
      };
    },
    async latest(_projectId: string, _userId: string, target: TargetLanguage, output: ExportOutput) {
      return {
        id: 'export-latest', projectId: 'project-1', targetLanguage: target, output, batchId: null,
        status: 'completed', exportObjectKey: `exports/${target}.mp4`, subtitleObjectKey: `exports/${target}.srt`,
        errorCode: null, errorMessage: null,
      };
    },
    async fail(_projectId: string, exportId: string, _userId: string, code: string) {
      calls.exportFailures.push({ id: exportId, code });
    },
  };
  const jobs = {
    async create(_projectId: string, type: string) {
      const id = `job-${nextJob++}`;
      calls.jobs.push(type);
      return { id };
    },
    async fail() {},
  };
  const env = {
    RATE_LIMIT_EXPORT: {
      async limit() {
        calls.rateLimits += 1;
        return { success: true };
      },
    },
    ANALYTICS: { writeDataPoint() {} },
    EXPORT_WORKFLOW: {
      async create(input: { params?: any }) {
        calls.workflow.push(input);
        if (input.params?.targetLanguage === options.failWorkflowTarget) throw new Error('workflow unavailable');
        return { id: `workflow-${calls.workflow.length}` };
      },
    },
    ELEVENLABS_API_KEY: 'voice-key',
    ELEVENLABS_DEFAULT_VOICE_ID: 'voice-id',
  } as unknown as Env;

  return {
    calls,
    env,
    deps: {
      makeProjects: () => projects,
      makeLanguages: () => languages,
      makeSegments: () => segments,
      makeVariants: () => variants,
      makeExports: () => exportsStore,
      makeJobs: () => jobs,
      getVoiceCapabilities: () => capabilities(options.voiceLanguages ?? ['vi', 'ja', 'ko']),
    },
  };
}

async function routesFor(h: ReturnType<typeof harness>) {
  const { createExportRoutes } = await import('../src/routes/export');
  return createExportRoutes(h.deps as any);
}

async function request(
  routes: Awaited<ReturnType<typeof routesFor>>,
  env: Env,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  return routes.fetch(new Request(`https://yupvox.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

describe('Phase 4C per-language export routes', () => {
  it('launches one immutable JA dubbed attempt only after target and voice qualification', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/ja', 'POST', { output: 'dubbed' });

    expect(response.status).toBe(202);
    expect(h.calls.rateLimits).toBe(1);
    expect(h.calls.exportCreates).toEqual([{ target: 'ja', output: 'dubbed', batchId: null, id: 'export-1' }]);
    expect(h.calls.workflow[0]?.params).toMatchObject({
      projectId: 'project-1', userId: 'dev-user', jobId: 'job-1', exportId: 'export-1',
      targetLanguage: 'ja', output: 'dubbed',
    });
  });

  it('allows subtitles without voice capability but fails closed for unknown or unsupported dubbed languages', async () => {
    const subtitles = harness({ voiceLanguages: 'unknown' });
    const subtitleRoutes = await routesFor(subtitles);
    const subtitleResponse = await request(subtitleRoutes, subtitles.env, '/project-1/exports/ja', 'POST', { output: 'subtitles' });
    expect(subtitleResponse.status).toBe(202);

    const unknown = harness({ voiceLanguages: 'unknown' });
    const unknownRoutes = await routesFor(unknown);
    const unknownResponse = await request(unknownRoutes, unknown.env, '/project-1/exports/ja', 'POST', { output: 'dubbed' });
    expect(unknownResponse.status).toBe(409);
    await expect(unknownResponse.json()).resolves.toMatchObject({ code: 'VOICE_LANGUAGE_UNQUALIFIED' });
    expect(unknown.calls.workflow).toHaveLength(0);

    const unsupported = harness({ voiceLanguages: ['vi'] });
    const unsupportedRoutes = await routesFor(unsupported);
    const unsupportedResponse = await request(unsupportedRoutes, unsupported.env, '/project-1/exports/ja', 'POST', { output: 'dubbed' });
    expect(unsupportedResponse.status).toBe(400);
    await expect(unsupportedResponse.json()).resolves.toMatchObject({ code: 'VOICE_LANGUAGE_UNSUPPORTED' });
    expect(unsupported.calls.workflow).toHaveLength(0);
  });

  it('requires enabled target and complete non-empty target translations before rate limiting', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const disabled = await request(routes, h.env, '/project-1/exports/en', 'POST', { output: 'subtitles' });
    expect(disabled.status).toBe(409);
    await expect(disabled.json()).resolves.toMatchObject({ code: 'PROJECT_LANGUAGE_NOT_ENABLED' });
    expect(h.calls.rateLimits).toBe(0);
  });

  it('fans out a batch under one batchId and isolates one Workflow start failure', async () => {
    const h = harness({ failWorkflowTarget: 'ja' });
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/batch', 'POST', {
      targetLanguages: ['vi', 'ja'],
      output: 'subtitles',
    });

    expect(response.status).toBe(202);
    expect(h.calls.exportCreates).toHaveLength(2);
    const batchIds = new Set(h.calls.exportCreates.map((row) => row.batchId));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toBeTruthy();
    expect(h.calls.workflow).toHaveLength(2);
    expect(h.calls.exportFailures).toEqual([{ id: 'export-2', code: 'EXPORT_WORKFLOW_START_FAILED' }]);
    await expect(response.json()).resolves.toMatchObject({
      batchId: expect.any(String),
      exports: [
        { targetLanguage: 'vi', status: 'queued' },
        { targetLanguage: 'ja', status: 'failed' },
      ],
    });
  });

  it('keeps legacy POST /:id/export exactly mapped to VI dubbed attempt', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/export', 'POST');

    expect(response.status).toBe(202);
    expect(h.calls.exportCreates).toEqual([{ target: 'vi', output: 'dubbed', batchId: null, id: 'export-1' }]);
    expect(h.calls.workflow[0]?.params).toMatchObject({ exportId: 'export-1', targetLanguage: 'vi', output: 'dubbed' });
  });
});