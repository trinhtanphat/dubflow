import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import type { SourceLanguage } from '../src/domain/project';
import type { Env } from '../src/env';
import { createTranslationRoutes } from '../src/routes/translation';
import type { TranslationItem, TranslationProvider, TranslationResult } from '../src/services/translation/types';
import { TranslationRouter } from '../src/services/translation/router';

afterEach(() => vi.unstubAllGlobals());

class StubProvider implements TranslationProvider {
  readonly capabilities: { contextual: boolean; available: boolean };

  constructor(private readonly name: string, contextual = false, available = true) {
    this.capabilities = { contextual, available };
  }

  async translateBatch(items: TranslationItem[], _source: SourceLanguage, _target: 'vi'): Promise<TranslationResult[]> {
    return items.map((item) => ({ id: item.id, text: `${this.name}:${item.text}`, provider: this.name }));
  }
}

const neutralContext = { revision: 1, style: 'neutral' as const, glossary: [] };
const activeContext = { revision: 7, style: 'natural' as const, glossary: [] };

function makeRouter(contextualAvailable = true) {
  return new (TranslationRouter as any)(
    new StubProvider('workers-ai'),
    new StubProvider('google'),
    new StubProvider('workers-ai-contextual', true, contextualAvailable),
  );
}

class TranslationStatement implements D1StatementLike {
  values: unknown[] = [];

  constructor(private readonly db: TranslationDb, public readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run(): Promise<D1RunResultLike> {
    if (this.sql.includes('UPDATE segments') && this.sql.includes('SET translated_text = ?')) {
      this.db.translationWrites += 1;
      const [translatedText, engine, contextRevision, segmentId, projectId, userId, expectedVersion] = this.values as [
        string, string, number | null, string, string, string, number | undefined,
      ];
      if (segmentId !== this.db.segment.id || projectId !== this.db.segment.project_id || userId !== 'dev-user') {
        return { meta: { changes: 0 } };
      }
      if (this.sql.includes('version = ?') && expectedVersion !== this.db.segment.version) {
        return { meta: { changes: 0 } };
      }
      this.db.segment.translated_text = translatedText;
      this.db.segment.translation_engine = engine;
      this.db.segment.translation_context_revision = contextRevision;
      this.db.segment.translation_status = 'completed';
      this.db.segment.voice_status = 'pending';
      this.db.segment.version += 1;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }

  async all<T>() {
    if (this.sql.includes('FROM project_glossary_entries')) {
      return {
        results: this.db.context.glossary.map((entry: any) => ({
          id: entry.id,
          project_id: 'project-1',
          source_term: entry.sourceTerm,
          preferred_translation: entry.preferredTranslation,
          note: entry.note ?? null,
          case_sensitive: entry.caseSensitive ? 1 : 0,
          created_at: entry.createdAt ?? '2026-09-06T00:00:00Z',
          updated_at: entry.updatedAt ?? '2026-09-06T00:00:00Z',
        })) as T[],
      };
    }
    return { results: [] as T[] };
  }

  async first<T>() {
    if (this.sql.includes('SELECT translation_style, translation_context_revision')) {
      const [projectId, userId] = this.values as [string, string];
      if (projectId !== 'project-1' || userId !== 'dev-user') return null;
      return {
        translation_style: this.db.context.style,
        translation_context_revision: this.db.context.revision,
      } as T;
    }
    if (this.sql.includes('FROM projects WHERE id = ? AND user_id = ?')) {
      const [projectId, userId] = this.values as [string, string];
      if (projectId !== 'project-1' || userId !== 'dev-user') return null;
      return {
        id: 'project-1', user_id: 'dev-user', title: 'Project', source_language: 'en', target_language: 'vi', status: 'ready',
        source_object_key: null, duration_ms: 10_000, size_bytes: null,
      } as T;
    }
    if (this.sql.includes('FROM segments s JOIN projects p')) {
      const [projectId, segmentId, userId] = this.values as [string, string, string];
      if (projectId !== this.db.segment.project_id || segmentId !== this.db.segment.id || userId !== 'dev-user') return null;
      return { ...this.db.segment } as T;
    }
    return null;
  }
}

class TranslationDb implements D1DatabaseLike {
  translationWrites = 0;
  context: any = { ...neutralContext };
  segment = {
    id: 'segment-1', project_id: 'project-1', speaker_id: null, start_ms: 0, end_ms: 1000,
    source_text: 'hello', translated_text: 'old translation', translation_engine: 'workers-ai', translation_context_revision: null as number | null,
    translation_status: 'completed', voice_status: 'pending', dubbed_object_key: null, version: 3, split_parent_id: null,
  };

  prepare(sql: string) {
    return new TranslationStatement(this, sql);
  }
}

const ai = {
  async run(_model: string, input: unknown) {
    if (input && typeof input === 'object' && Array.isArray((input as any).messages)) {
      return {
        response: JSON.stringify({
          translations: [{ id: 'segment-1', text: 'contextual translated' }],
        }),
      };
    }
    return { translated_text: 'workers translated' };
  },
} satisfies AiBinding;

function translationEnv(db: TranslationDb, model = '@cf/example/context-model'): Env {
  return {
    DB: db,
    AI: ai,
    CONTEXT_TRANSLATION_MODEL: model,
    GOOGLE_CLOUD_TRANSLATE_API_KEY: 'google-key',
  } as unknown as Env;
}

describe('translation router', () => {
  it('derives raw workers-ai for neutral empty context and includes null provenance', async () => {
    const router = makeRouter();
    await expect((router.translate as any)(undefined, [{ id: '1', text: 'x' }], 'en', 'vi', neutralContext)).resolves.toEqual({
      mode: 'workers-ai',
      primary: [{ id: '1', text: 'workers-ai:x', provider: 'workers-ai' }],
      contextRevision: null,
    });
  });

  it('derives contextual mode when project context is active', async () => {
    const router = makeRouter();
    await expect((router.translate as any)(undefined, [{ id: '1', text: 'x' }], 'en', 'vi', activeContext)).resolves.toEqual({
      mode: 'contextual',
      primary: [{ id: '1', text: 'workers-ai-contextual:x', provider: 'workers-ai-contextual' }],
      contextRevision: 7,
    });
  });

  it('allows explicit contextual mode for neutral context', async () => {
    const router = makeRouter();
    await expect((router.translate as any)('contextual', [{ id: '1', text: 'x' }], 'en', 'vi', neutralContext)).resolves.toMatchObject({
      mode: 'contextual',
      contextRevision: 1,
    });
  });

  it('rejects raw or compare modes when active context would be discarded', async () => {
    const router = makeRouter();
    for (const mode of ['workers-ai', 'google', 'compare']) {
      await expect((router.translate as any)(mode, [{ id: '1', text: 'x' }], 'en', 'vi', activeContext))
        .rejects.toMatchObject({ code: 'TRANSLATION_CONTEXT_UNSUPPORTED' });
    }
  });

  it('rejects contextual mode when the contextual provider is unavailable', async () => {
    const router = makeRouter(false);
    await expect((router.translate as any)('contextual', [{ id: '1', text: 'x' }], 'en', 'vi', neutralContext))
      .rejects.toMatchObject({ code: 'CONTEXT_TRANSLATION_UNAVAILABLE' });
  });

  it('returns both raw alternatives in compare mode only for inactive context', async () => {
    const router = makeRouter();
    await expect((router.translate as any)('compare', [{ id: '1', text: 'x' }], 'en', 'vi', neutralContext)).resolves.toEqual({
      mode: 'compare',
      workersAI: [{ id: '1', text: 'workers-ai:x', provider: 'workers-ai' }],
      google: [{ id: '1', text: 'google:x', provider: 'google' }],
      contextRevision: null,
    });
  });
});

describe('revision-aware translation HTTP route', () => {
  it('rejects a stale persisted retranslation without overwriting the canonical segment', async () => {
    const db = new TranslationDb();
    const routes = createTranslationRoutes();
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/segments/segment-1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, mode: 'workers-ai' }),
    }), translationEnv(db));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SEGMENT_VERSION_CONFLICT',
      segment: { id: 'segment-1', version: 3, translatedText: 'old translation' },
    });
    expect(db.segment.translated_text).toBe('old translation');
    expect(db.segment.version).toBe(3);
  });

  it('keeps compare mode read-only when translation context is inactive', async () => {
    const db = new TranslationDb();
    vi.stubGlobal('fetch', async () => Response.json({
      data: { translations: [{ translatedText: 'google translated' }] },
    }));
    const routes = createTranslationRoutes();
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/segments/segment-1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, mode: 'compare' }),
    }), translationEnv(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'compare',
      contextRevision: null,
      workersAI: [{ text: 'workers translated' }],
      google: [{ text: 'google translated' }],
    });
    expect(db.translationWrites).toBe(0);
    expect(db.segment.version).toBe(3);
  });

  it('defaults active context to contextual translation and persists its snapshot revision', async () => {
    const db = new TranslationDb();
    db.context = { ...activeContext };
    const routes = createTranslationRoutes();
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/segments/segment-1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3 }),
    }), translationEnv(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'contextual',
      result: { text: 'contextual translated', provider: 'workers-ai-contextual' },
      segment: {
        translationEngine: 'workers-ai',
        translationContextRevision: 7,
      },
    });
    expect(db.translationWrites).toBe(1);
    expect(db.segment.translation_engine).toBe('workers-ai');
    expect(db.segment.translation_context_revision).toBe(7);
  });

  it('rejects an explicit raw provider when active context would be discarded', async () => {
    const db = new TranslationDb();
    db.context = { ...activeContext };
    vi.stubGlobal('fetch', async () => Response.json({
      data: { translations: [{ translatedText: 'google translated' }] },
    }));
    const routes = createTranslationRoutes();
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/segments/segment-1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, mode: 'google' }),
    }), translationEnv(db));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'TRANSLATION_CONTEXT_UNSUPPORTED' });
    expect(db.translationWrites).toBe(0);
    expect(db.segment.translated_text).toBe('old translation');
  });

  it('fails closed with 503 when active context requires an unavailable contextual model', async () => {
    const db = new TranslationDb();
    db.context = { ...activeContext };
    const routes = createTranslationRoutes();
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/segments/segment-1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3 }),
    }), translationEnv(db, '   '));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONTEXT_TRANSLATION_UNAVAILABLE' });
    expect(db.translationWrites).toBe(0);
  });

  it('persists raw Workers AI with null context provenance when context is inactive', async () => {
    const db = new TranslationDb();
    const routes = createTranslationRoutes();
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/segments/segment-1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, mode: 'workers-ai' }),
    }), translationEnv(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'workers-ai',
      segment: { translationContextRevision: null },
    });
    expect(db.translationWrites).toBe(1);
    expect(db.segment.translation_context_revision).toBeNull();
  });
});
