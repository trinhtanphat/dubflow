import { describe, expect, it, vi } from 'vitest';
import { TranslationContextRepository } from '../src/db/translation-context';
import { createTranslationContextRoutes } from '../src/routes/translation-context';
import { createTranslationRoutes } from '../src/routes/translation';

type RecordedCall = { sql: string; values: unknown[] };

function targetAwareDb() {
  const calls: RecordedCall[] = [];
  const rows = [
    {
      id: 'vi-entry', project_id: 'p1', target_language: 'vi', source_term: 'Hello',
      preferred_translation: 'Xin chào', note: null, case_sensitive: 0,
      created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    },
    {
      id: 'ja-entry', project_id: 'p1', target_language: 'ja', source_term: 'Hello',
      preferred_translation: 'こんにちは', note: null, case_sensitive: 0,
      created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    },
  ];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first<T>() {
          calls.push({ sql, values });
          if (/FROM projects/i.test(sql)) {
            return { translation_style: 'formal', translation_context_revision: 9 } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ sql, values });
          const target = values.find((value) => value === 'vi' || value === 'ja');
          const selected = target ? rows.filter((row) => row.target_language === target) : rows;
          return { results: selected as T[] };
        },
        async run() { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
      };
    },
  };
  return { db: db as any, calls };
}

function routeEnv() {
  return {
    CONTEXT_TRANSLATION_MODEL: '@cf/example/context-model',
    ANALYTICS: { writeDataPoint() {} },
    RATE_LIMIT_TRANSLATE: { async limit() { return { success: true }; } },
  } as any;
}

describe('Phase 4C target-aware translation context', () => {
  it('scopes repository glossary rows to the requested target while keeping project-global style/revision', async () => {
    const { db, calls } = targetAwareDb();
    const repo = new TranslationContextRepository(db);

    const context = await (repo.getContext as any)('p1', 'dev-user', 'ja');

    expect(context).toMatchObject({ revision: 9, style: 'formal' });
    expect(context?.glossary).toEqual([
      expect.objectContaining({ id: 'ja-entry', targetLanguage: 'ja', preferredTranslation: 'こんにちは' }),
    ]);
    const glossaryQuery = calls.find((call) => /FROM project_glossary_entries/i.test(call.sql));
    expect(glossaryQuery?.sql).toMatch(/target_language\s*=\s*\?/i);
    expect(glossaryQuery?.values).toContain('ja');
  });

  it('legacy glossary GET defaults to vi and query targetLanguage scopes reads', async () => {
    const getContext = vi.fn(async (_projectId: string, _userId: string, targetLanguage: string) => ({
      revision: 3,
      style: 'neutral',
      glossary: [{ id: `${targetLanguage}-entry`, projectId: 'p1', targetLanguage, sourceTerm: 'x', preferredTranslation: 'y', note: null, caseSensitive: false, createdAt: '', updatedAt: '' }],
    }));
    const routes = createTranslationContextRoutes({ makeContext: () => ({ getContext } as any) });

    const legacy = await routes.fetch(new Request('https://yupvox.test/p1/glossary'), routeEnv());
    expect(legacy.status).toBe(200);
    expect(getContext).toHaveBeenNthCalledWith(1, 'p1', 'dev-user', 'vi');

    const japanese = await routes.fetch(new Request('https://yupvox.test/p1/glossary?targetLanguage=ja'), routeEnv());
    expect(japanese.status).toBe(200);
    expect(getContext).toHaveBeenNthCalledWith(2, 'p1', 'dev-user', 'ja');
  });

  it('rejects an unsupported glossary target before repository access', async () => {
    const getContext = vi.fn();
    const routes = createTranslationContextRoutes({ makeContext: () => ({ getContext } as any) });

    const response = await routes.fetch(new Request('https://yupvox.test/p1/glossary?targetLanguage=fr'), routeEnv());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'TARGET_LANGUAGE_UNSUPPORTED' });
    expect(getContext).not.toHaveBeenCalled();
  });

  it('create glossary accepts and forwards a validated targetLanguage', async () => {
    const createEntry = vi.fn(async (_projectId: string, _userId: string, _revision: number, input: any) => ({
      entry: { id: 'g1', projectId: 'p1', targetLanguage: input.targetLanguage, sourceTerm: input.sourceTerm, preferredTranslation: input.preferredTranslation, note: null, caseSensitive: false, createdAt: '', updatedAt: '' },
      context: { revision: 4, style: 'neutral', glossary: [] },
    }));
    const routes = createTranslationContextRoutes({ makeContext: () => ({ createEntry } as any) });
    const response = await routes.fetch(new Request('https://yupvox.test/p1/glossary', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedContextRevision: 3, targetLanguage: 'ja', sourceTerm: 'Hello', preferredTranslation: 'こんにちは', caseSensitive: false }),
    }), routeEnv());

    expect(response.status).toBe(201);
    expect(createEntry).toHaveBeenCalledWith('p1', 'dev-user', 3, expect.objectContaining({ targetLanguage: 'ja' }));
  });

  it('legacy single-segment retranslate explicitly loads Vietnamese context', async () => {
    const getContext = vi.fn(async () => ({ revision: 1, style: 'neutral', glossary: [] }));
    const router = { translate: vi.fn(async () => ({ mode: 'workers-ai', primary: [{ id: 's1', text: 'Xin chào', provider: 'workers-ai' }], contextRevision: null })) };
    const segments = {
      get: vi.fn(async () => ({ id: 's1', projectId: 'p1', sourceText: 'Hello', translatedText: '', version: 2 })),
      setTranslationResult: vi.fn(async () => ({ id: 's1', projectId: 'p1', sourceText: 'Hello', translatedText: 'Xin chào', version: 3 })),
    };
    const projects = { getByIdForUser: vi.fn(async () => ({ id: 'p1', sourceLanguage: 'en' })) };
    const routes = createTranslationRoutes({
      makeContext: () => ({ getContext } as any),
      makeRouter: () => router as any,
      makeSegments: () => segments as any,
      makeProjects: () => projects as any,
    });

    const response = await routes.fetch(new Request('https://yupvox.test/p1/segments/s1/retranslate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 2 }),
    }), routeEnv());

    expect(response.status).toBe(200);
    expect(getContext).toHaveBeenCalledWith('p1', 'dev-user', 'vi');
    expect(router.translate).toHaveBeenCalledWith(undefined, [{ id: 's1', text: 'Hello' }], 'en', 'vi', expect.any(Object));
  });
});
