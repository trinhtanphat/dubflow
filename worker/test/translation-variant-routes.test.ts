import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { SegmentTranslationPersistenceError, type SegmentTranslation } from '../src/db/segment-translations';
import type { TargetLanguage } from '../src/domain/language';

const project = {
  id: 'project-1',
  userId: 'dev-user',
  title: 'Demo',
  sourceLanguage: 'en',
  targetLanguage: 'vi',
  targetLanguagesRevision: 3,
  status: 'needs_review',
};

const canonicalSegments = [
  {
    id: 'segment-1', projectId: 'project-1', speakerId: 'speaker-1', startMs: 0, endMs: 1000,
    sourceText: 'Hello', translatedText: 'Xin chào', translationEngine: 'workers-ai',
    translationContextRevision: 2, translationStatus: 'completed', voiceStatus: 'pending',
    dubbedObjectKey: null, version: 5, splitParentId: null,
  },
  {
    id: 'segment-2', projectId: 'project-1', speakerId: null, startMs: 1000, endMs: 2000,
    sourceText: 'World', translatedText: 'Thế giới', translationEngine: 'workers-ai',
    translationContextRevision: 2, translationStatus: 'completed', voiceStatus: 'pending',
    dubbedObjectKey: null, version: 4, splitParentId: null,
  },
];

const jaVariant: SegmentTranslation = {
  segmentId: 'segment-1',
  projectId: 'project-1',
  targetLanguage: 'ja',
  translatedText: 'こんにちは',
  translationEngine: 'workers-ai',
  translationStatus: 'completed',
  translationContextRevision: 7,
  voiceStatus: 'pending',
  dubbedObjectKey: null,
  version: 2,
};

function job() {
  return {
    id: 'job-1', projectId: 'project-1', type: 'translation:ja', status: 'queued', progress: 0,
    currentStep: null, errorCode: null, errorMessage: null, retryCount: 0,
    createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
  };
}

function harness() {
  const calls = {
    variantUpdates: [] as Array<{ target: TargetLanguage; segmentId: string; expectedVersion: number; text: string }>,
    persistedTargets: [] as TargetLanguage[],
    contextTargets: [] as TargetLanguage[],
    routerTargets: [] as TargetLanguage[],
    routerItems: [] as unknown[],
    rateLimits: 0,
    workflowCreates: [] as Array<{ id?: string; params?: unknown }>,
    jobs: 0,
  };
  let conflict = false;

  const projects = {
    async getByIdForUser(id: string, userId: string) {
      return id === 'project-1' && userId === 'dev-user' ? project : null;
    },
  };
  const segments = {
    async list(projectId: string, userId: string) {
      return projectId === 'project-1' && userId === 'dev-user' ? canonicalSegments : [];
    },
    async get(projectId: string, segmentId: string, userId: string) {
      return projectId === 'project-1' && userId === 'dev-user'
        ? canonicalSegments.find((segment) => segment.id === segmentId) ?? null
        : null;
    },
  };
  const variants = {
    async list(_projectId: string, _userId: string, target: TargetLanguage) {
      return target === 'ja' ? [jaVariant] : [];
    },
    async get(_projectId: string, segmentId: string, _userId: string, target: TargetLanguage) {
      return target === 'ja' && segmentId === 'segment-1' ? jaVariant : null;
    },
    async updateText(
      _projectId: string,
      segmentId: string,
      _userId: string,
      target: TargetLanguage,
      expectedVersion: number,
      text: string,
    ) {
      calls.variantUpdates.push({ target, segmentId, expectedVersion, text });
      if (conflict) {
        throw new SegmentTranslationPersistenceError(
          'TRANSLATION_VARIANT_CONFLICT',
          'Translation variant changed on the server.',
          jaVariant,
        );
      }
      return { ...jaVariant, targetLanguage: target, translatedText: text, version: expectedVersion + 1 };
    },
    async setTranslationResult(
      _projectId: string,
      _segmentId: string,
      _userId: string,
      target: TargetLanguage,
      text: string,
      engine: 'workers-ai' | 'google',
      contextRevision: number | null,
    ) {
      calls.persistedTargets.push(target);
      return { ...jaVariant, targetLanguage: target, translatedText: text, translationEngine: engine, translationContextRevision: contextRevision };
    },
  };
  const languages = {
    async getConfig(projectId: string, userId: string) {
      return projectId === 'project-1' && userId === 'dev-user'
        ? { revision: 3, languages: [{ targetLanguage: 'vi', status: 'needs_review' }, { targetLanguage: 'ja', status: 'needs_review' }] }
        : null;
    },
    async setStatus() {},
  };
  const contexts = {
    async getContext(_projectId: string, _userId: string, target: TargetLanguage) {
      calls.contextTargets.push(target);
      return { revision: 7, style: 'neutral', glossary: [] };
    },
  };
  const router = {
    async translate(_mode: unknown, items: unknown[], _source: unknown, target: TargetLanguage) {
      calls.routerTargets.push(target);
      calls.routerItems.push(items);
      return {
        mode: 'workers-ai' as const,
        primary: [{ id: 'segment-1', text: 'やあ', provider: 'workers-ai' as const }],
        contextRevision: 7,
      };
    },
  };
  const jobs = {
    async create() {
      calls.jobs += 1;
      return job();
    },
    async fail() {},
  };
  const env = {
    RATE_LIMIT_TRANSLATE: {
      async limit() {
        calls.rateLimits += 1;
        return { success: true };
      },
    },
    LANGUAGE_TRANSLATION_WORKFLOW: {
      async create(input: { id?: string; params?: unknown }) {
        calls.workflowCreates.push(input);
        return { id: 'workflow-1' };
      },
    },
  } as unknown as Env;

  return {
    calls,
    projects,
    segments,
    variants,
    languages,
    contexts,
    router,
    jobs,
    env,
    setConflict(value: boolean) { conflict = value; },
  };
}

async function routesFor(h: ReturnType<typeof harness>) {
  const { createTranslationVariantRoutes } = await import('../src/routes/translation-variants');
  return createTranslationVariantRoutes({
    makeProjects: () => h.projects as any,
    makeSegments: () => h.segments as any,
    makeVariants: () => h.variants as any,
    makeLanguages: () => h.languages as any,
    makeContext: () => h.contexts as any,
    makeRouter: () => h.router as any,
    makeJobs: () => h.jobs as any,
  });
}

async function jsonRequest(
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

describe('Phase 4C target translation variant routes', () => {
  it('combines canonical source identity and timing with the requested target variant', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await jsonRequest(routes, h.env, '/project-1/translations/ja');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      targetLanguage: 'ja',
      segments: [
        {
          segmentId: 'segment-1', sourceText: 'Hello', startMs: 0, endMs: 1000, speakerId: 'speaker-1',
          translation: { targetLanguage: 'ja', translatedText: 'こんにちは', version: 2 },
        },
        {
          segmentId: 'segment-2', sourceText: 'World', startMs: 1000, endMs: 2000,
          translation: null,
        },
      ],
    });
  });

  it('keeps a JA editor patch scoped to the JA variant and returns stale canonical state on conflict', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const updated = await jsonRequest(routes, h.env, '/project-1/translations/ja/segment-1', 'PATCH', {
      expectedVersion: 2,
      translatedText: 'こんにちは世界',
    });
    expect(updated.status).toBe(200);
    expect(h.calls.variantUpdates).toEqual([{
      target: 'ja', segmentId: 'segment-1', expectedVersion: 2, text: 'こんにちは世界',
    }]);

    h.setConflict(true);
    const stale = await jsonRequest(routes, h.env, '/project-1/translations/ja/segment-1', 'PATCH', {
      expectedVersion: 1,
      translatedText: 'stale',
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: 'TRANSLATION_VARIANT_CONFLICT',
      canonical: { segmentId: 'segment-1', targetLanguage: 'ja', version: 2 },
    });
  });

  it('retranslates the canonical source into the requested target and persists only that target', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await jsonRequest(routes, h.env, '/project-1/translations/ja/segment-1/retranslate', 'POST', {
      mode: 'workers-ai',
    });

    expect(response.status).toBe(200);
    expect(h.calls.contextTargets).toEqual(['ja']);
    expect(h.calls.routerTargets).toEqual(['ja']);
    expect(h.calls.routerItems).toEqual([[{ id: 'segment-1', text: 'Hello' }]]);
    expect(h.calls.persistedTargets).toEqual(['ja']);
  });

  it('authorizes and validates before translate rate limit, then launches target workflow params', async () => {
    const h = harness();
    const routes = await routesFor(h);

    const invalid = await jsonRequest(routes, h.env, '/project-1/translations/fr/process', 'POST');
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'TARGET_LANGUAGE_UNSUPPORTED' });
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.workflowCreates).toHaveLength(0);

    const response = await jsonRequest(routes, h.env, '/project-1/translations/ja/process', 'POST');
    expect(response.status).toBe(202);
    expect(h.calls.rateLimits).toBe(1);
    expect(h.calls.jobs).toBe(1);
    expect(h.calls.workflowCreates).toHaveLength(1);
    expect(h.calls.workflowCreates[0]?.params).toMatchObject({
      projectId: 'project-1', userId: 'dev-user', jobId: 'job-1', targetLanguage: 'ja',
    });
    await expect(response.json()).resolves.toMatchObject({
      jobId: 'job-1', workflowId: 'workflow-1', status: 'queued', targetLanguage: 'ja',
    });
  });

  it('hides non-owned projects before target route side effects', async () => {
    const h = harness();
    const routes = await routesFor(h);
    const response = await jsonRequest(routes, h.env, '/other-project/translations/ja/process', 'POST');
    expect(response.status).toBe(404);
    expect(h.calls.rateLimits).toBe(0);
    expect(h.calls.workflowCreates).toHaveLength(0);
  });
});
