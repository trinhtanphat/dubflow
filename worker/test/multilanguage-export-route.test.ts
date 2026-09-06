import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { DubbedAudioMode } from '../src/domain/audio-mode';
import type { ExportOutput, TargetLanguage } from '../src/domain/language';
import type { DialogueSeparationCapabilities } from '../src/services/separation/types';
import type { VoiceCapabilities } from '../src/services/voice/types';

const project = {
  id: 'project-1', userId: 'dev-user', title: 'Demo', sourceLanguage: 'en', targetLanguage: 'vi',
  targetLanguagesRevision: 3, status: 'needs_review', sourceObjectKey: 'projects/project-1/source.mp4',
  sourceGeneration: 1, exportObjectKey: null,
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

const unavailableSeparation: DialogueSeparationCapabilities = {
  configured: false,
  provider: null,
  backgroundStem: false,
  dialogueStem: false,
  qualification: 'unavailable',
};

function harness(options: {
  voiceLanguages?: string[] | 'unknown';
  failWorkflowTarget?: TargetLanguage;
  separation?: DialogueSeparationCapabilities;
} = {}) {
  const calls = {
    rateLimits: 0,
    separationCapabilities: 0,
    exportCreates: [] as Array<{
      target: TargetLanguage;
      output: ExportOutput;
      batchId: string | null;
      audioMode: DubbedAudioMode;
      id: string;
    }>,
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
    async create(
      _projectId: string,
      _userId: string,
      target: TargetLanguage,
      output: ExportOutput,
      batchId: string | null = null,
      audioMode: DubbedAudioMode = 'dubbed_only',
    ) {
      const id = `export-${nextExport++}`;
      const effectiveAudioMode: DubbedAudioMode = output === 'subtitles' ? 'dubbed_only' : audioMode;
      calls.exportCreates.push({ target, output, batchId, audioMode: effectiveAudioMode, id });
      return {
        id, projectId: 'project-1', targetLanguage: target, output, batchId, audioMode: effectiveAudioMode,
        status: 'pending', exportObjectKey: null, subtitleObjectKey: null, errorCode: null, errorMessage: null,
      };
    },
    async latest(_projectId: string, _userId: string, target: TargetLanguage, output: ExportOutput) {
      return {
        id: 'export-latest', projectId: 'project-1', targetLanguage: target, output, batchId: null,
        audioMode: 'dubbed_only' as const,
        status: 'completed', exportObjectKey: `exports/${target}.mp4`, subtitleObjectKey: `exports/${target}.srt`,
        errorCode: null, errorMessage: null,
      };
    },
    async latestCompleted(_projectId: string, _userId: string, target: TargetLanguage, output: ExportOutput) {
      return {
        id: 'export-latest', projectId: 'project-1', targetLanguage: target, output, batchId: null,
        audioMode: 'dubbed_only' as const,
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
  const allowedLimiter = {
    async limit() {
      calls.rateLimits += 1;
      return { success: true };
    },
  };
  const env = {
    RATE_LIMIT_EXPORT: allowedLimiter,
    RATE_LIMIT_BATCH_EXPORT: allowedLimiter,
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
      makeSeparation: () => ({
        async capabilities() {
          calls.separationCapabilities += 1;
          return options.separation ?? unavailableSeparation;
        },
        async separate() {
          throw new Error('separation should not run in route admission tests');
        },
      }),
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
    expect(h.calls.exportCreates).toEqual([{
      target: 'ja', output: 'dubbed', batchId: null, audioMode: 'dubbed_only', id: 'export-1',
    }]);
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
    expect(h.calls.exportCreates).toEqual([{
      target: 'vi', output: 'dubbed', batchId: null, audioMode: 'dubbed_only', id: 'export-1',
    }]);
    expect(h.calls.workflow[0]?.params).toMatchObject({ exportId: 'export-1', targetLanguage: 'vi', output: 'dubbed' });
  });
});

describe('Phase 4D export audio treatment admission', () => {
  it('defaults omitted dubbed mode and persists/forwards dubbed_only', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/ja', 'POST', { output: 'dubbed' });

    expect(response.status).toBe(202);
    expect(h.calls.exportCreates[0]?.audioMode).toBe('dubbed_only');
    expect(h.calls.workflow[0]?.params).toMatchObject({ audioMode: 'dubbed_only' });
    expect(h.calls.separationCapabilities).toBe(0);
  });

  it('propagates one duck_original mode across a dubbed batch without touching separation', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/batch', 'POST', {
      targetLanguages: ['vi', 'ja'],
      output: 'dubbed',
      audioMode: 'duck_original',
    });

    expect(response.status).toBe(202);
    expect(h.calls.exportCreates.map((row) => row.audioMode)).toEqual(['duck_original', 'duck_original']);
    expect(h.calls.workflow.map((row) => row.params?.audioMode)).toEqual(['duck_original', 'duck_original']);
    expect(h.calls.separationCapabilities).toBe(0);
  });

  it('rejects invalid audio mode before rate limits or export side effects', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/ja', 'POST', {
      output: 'dubbed',
      audioMode: 'bad',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'AUDIO_MODE_INVALID' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exportCreates).toHaveLength(0);
    expect(h.calls.jobs).toHaveLength(0);
    expect(h.calls.workflow).toHaveLength(0);
  });

  it('rejects non-default subtitle treatment before rate limits or export side effects', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/ja', 'POST', {
      output: 'subtitles',
      audioMode: 'duck_original',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'AUDIO_MODE_INVALID' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exportCreates).toHaveLength(0);
    expect(h.calls.jobs).toHaveLength(0);
    expect(h.calls.workflow).toHaveLength(0);
  });

  it('fails closed when separated background capability is unavailable before billable/admission side effects', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/ja', 'POST', {
      output: 'dubbed',
      audioMode: 'separated_background',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'DIALOGUE_SEPARATION_UNAVAILABLE' });
    expect(h.calls.separationCapabilities).toBe(1);
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exportCreates).toHaveLength(0);
    expect(h.calls.jobs).toHaveLength(0);
    expect(h.calls.workflow).toHaveLength(0);
  });

  it('fails closed for an unqualified separation provider before side effects', async () => {
    const h = harness({
      separation: {
        configured: true,
        provider: 'future-provider',
        backgroundStem: true,
        dialogueStem: true,
        qualification: 'unqualified',
      },
    });
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/ja', 'POST', {
      output: 'dubbed',
      audioMode: 'separated_background',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'DIALOGUE_SEPARATION_UNQUALIFIED' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.exportCreates).toHaveLength(0);
    expect(h.calls.jobs).toHaveLength(0);
    expect(h.calls.workflow).toHaveLength(0);
  });

  it('admits a qualified separated background request and persists/forwards the mode', async () => {
    const h = harness({
      separation: {
        configured: true,
        provider: 'qualified-provider',
        backgroundStem: true,
        dialogueStem: false,
        qualification: 'qualified',
      },
    });
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/exports/ja', 'POST', {
      output: 'dubbed',
      audioMode: 'separated_background',
    });

    expect(response.status).toBe(202);
    expect(h.calls.separationCapabilities).toBe(1);
    expect(h.calls.exportCreates[0]?.audioMode).toBe('separated_background');
    expect(h.calls.workflow[0]?.params).toMatchObject({ audioMode: 'separated_background' });
  });

  it('exposes owner-scoped audio treatment capabilities and hides provider state for missing projects', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await request(routes, h.env, '/project-1/export-capabilities');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      duckOriginal: true,
      separation: unavailableSeparation,
    });
    expect(h.calls.separationCapabilities).toBe(1);

    const missing = harness();
    const missingRoutes = await routesFor(missing);
    const missingResponse = await request(missingRoutes, missing.env, '/missing/export-capabilities');
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(missing.calls.separationCapabilities).toBe(0);
  });
});
