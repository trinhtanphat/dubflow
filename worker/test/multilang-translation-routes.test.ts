import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { createTranslationRoutes } from '../src/routes/translation';

function env(limiter = vi.fn(async () => ({ success: true }))) {
  return {
    RATE_LIMIT_TRANSLATE: { limit: limiter },
    ANALYTICS: { writeDataPoint() {} },
  } as unknown as Env;
}

function deps() {
  const project = { id: 'p1', sourceLanguage: 'en' as const };
  const segment = {
    id: 's1', projectId: 'p1', speakerId: null, startMs: 0, endMs: 1000,
    sourceText: 'Hello', translatedText: 'Xin chào', translationEngine: 'workers-ai',
    translationContextRevision: 1, translationStatus: 'completed', voiceStatus: 'pending',
    dubbedObjectKey: null, version: 2, splitParentId: null,
  };
  const translate = vi.fn(async (_mode, _items, _source, target) => ({
    mode: 'workers-ai' as const,
    primary: [{ id: 's1', text: target === 'ja' ? 'こんにちは' : 'Xin chào', provider: 'workers-ai' as const }],
    contextRevision: 7,
  }));
  const setTranslationResult = vi.fn(async () => ({ ...segment, version: 3 }));
  const getTranslation = vi.fn(async () => null);
  const upsertTranslation = vi.fn(async (input) => input);
  const invalidateSegmentTarget = vi.fn(async () => {});
  return {
    translate,
    setTranslationResult,
    getTranslation,
    upsertTranslation,
    invalidateSegmentTarget,
    routeDeps: {
      makeProjects: () => ({ getByIdForUser: vi.fn(async () => project) }),
      makeSegments: () => ({
        get: vi.fn(async () => segment),
        setTranslationResult,
      }),
      makeContext: () => ({
        getContext: vi.fn(async () => ({
          projectId: 'p1', userId: 'dev-user', revision: 7, style: { preset: 'neutral' }, glossary: [],
        })),
      }),
      makeRouter: () => ({ translate }),
      makeMultilang: () => ({ getTranslation, upsertTranslation, invalidateSegmentTarget }),
    },
  };
}

describe('Phase 4C target-aware retranslation route', () => {
  it('persists a non-Vietnamese translation in target state without overwriting legacy Vietnamese fields', async () => {
    const d = deps();
    const routes = createTranslationRoutes(d.routeDeps as any);
    const response = await routes.fetch(new Request('https://yupvox.test/p1/segments/s1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, mode: 'workers-ai', targetLanguage: 'ja' }),
    }), env());

    expect(response.status).toBe(200);
    expect(d.translate).toHaveBeenCalledWith('workers-ai', [{ id: 's1', text: 'Hello' }], 'en', 'ja', expect.objectContaining({ revision: 7 }));
    expect(d.getTranslation).toHaveBeenCalledWith('p1', 's1', 'dev-user', 'ja');
    expect(d.upsertTranslation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', segmentId: 's1', userId: 'dev-user', targetLanguage: 'ja', translatedText: 'こんにちは',
      translationStatus: 'completed', contextRevision: 7, sourceSegmentVersion: 2, version: 1,
    }));
    expect(d.invalidateSegmentTarget).toHaveBeenCalledWith('p1', 's1', 'dev-user', 'ja');
    expect(d.setTranslationResult).not.toHaveBeenCalled();
  });

  it('rejects an unsupported target before limiter or provider work', async () => {
    const d = deps();
    const limiter = vi.fn(async () => ({ success: true }));
    const routes = createTranslationRoutes(d.routeDeps as any);
    const response = await routes.fetch(new Request('https://yupvox.test/p1/segments/s1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, mode: 'workers-ai', targetLanguage: 'fr' }),
    }), env(limiter));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'TRANSLATION_TARGET_UNSUPPORTED' });
    expect(limiter).not.toHaveBeenCalled();
    expect(d.translate).not.toHaveBeenCalled();
    expect(d.upsertTranslation).not.toHaveBeenCalled();
  });
});
