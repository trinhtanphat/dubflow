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
  constructor(private readonly name: string) {}
  async translateBatch(items: TranslationItem[], _source: SourceLanguage, _target: 'vi'): Promise<TranslationResult[]> {
    return items.map((item) => ({ id: item.id, text: `${this.name}:${item.text}`, provider: this.name }));
  }
}

class TranslationStatement implements D1StatementLike {
  values: unknown[] = [];

  constructor(private readonly db: TranslationDb, public readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run(): Promise<D1RunResultLike> {
    if (this.sql.includes('UPDATE segments SET translated_text = ?')) {
      this.db.translationWrites += 1;
      const [translatedText, engine, segmentId, projectId, userId, expectedVersion] = this.values as [string, string, string, string, string, number | undefined];
      if (segmentId !== this.db.segment.id || projectId !== this.db.segment.project_id || userId !== 'dev-user') {
        return { meta: { changes: 0 } };
      }
      if (this.sql.includes('version = ?') && expectedVersion !== this.db.segment.version) {
        return { meta: { changes: 0 } };
      }
      this.db.segment.translated_text = translatedText;
      this.db.segment.translation_engine = engine;
      this.db.segment.translation_status = 'completed';
      this.db.segment.version += 1;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }

  async all<T>() {
    return { results: [] as T[] };
  }

  async first<T>() {
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
  segment = {
    id: 'segment-1', project_id: 'project-1', speaker_id: null, start_ms: 0, end_ms: 1000,
    source_text: 'hello', translated_text: 'old translation', translation_engine: 'workers-ai', translation_status: 'completed',
    voice_status: 'pending', version: 3, split_parent_id: null,
  };

  prepare(sql: string) {
    return new TranslationStatement(this, sql);
  }
}

const ai = {
  async run() { return { translated_text: 'workers translated' }; },
} satisfies AiBinding;

function translationEnv(db: TranslationDb): Env {
  return {
    DB: db,
    AI: ai,
    GOOGLE_CLOUD_TRANSLATE_API_KEY: 'google-key',
  } as unknown as Env;
}

const noOpUsage = () => ({
  async record(input: unknown) { return { inserted: true, event: input }; },
});

describe('translation router', () => {
  it('selects workers-ai or google modes', async () => {
    const router = new TranslationRouter(new StubProvider('workers-ai'), new StubProvider('google'));
    expect(await router.translate('workers-ai', [{ id: '1', text: 'x' }], 'en', 'vi')).toEqual({
      mode: 'workers-ai', primary: [{ id: '1', text: 'workers-ai:x', provider: 'workers-ai' }],
    });
    expect(await router.translate('google', [{ id: '1', text: 'x' }], 'en', 'vi')).toEqual({
      mode: 'google', primary: [{ id: '1', text: 'google:x', provider: 'google' }],
    });
  });

  it('returns both alternatives in compare mode without choosing one', async () => {
    const router = new TranslationRouter(new StubProvider('workers-ai'), new StubProvider('google'));
    expect(await router.translate('compare', [{ id: '1', text: 'x' }], 'en', 'vi')).toEqual({
      mode: 'compare',
      workersAI: [{ id: '1', text: 'workers-ai:x', provider: 'workers-ai' }],
      google: [{ id: '1', text: 'google:x', provider: 'google' }],
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

  it('keeps compare mode read-only even when both providers run', async () => {
    const db = new TranslationDb();
    vi.stubGlobal('fetch', async () => Response.json({
      data: { translations: [{ translatedText: 'google translated' }] },
    }));
    const routes = createTranslationRoutes(noOpUsage);
    const response = await routes.fetch(new Request('https://yupvox.test/project-1/segments/segment-1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, mode: 'compare' }),
    }), translationEnv(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'compare',
      workersAI: [{ text: 'workers translated' }],
      google: [{ text: 'google translated' }],
    });
    expect(db.translationWrites).toBe(0);
    expect(db.segment.version).toBe(3);
  });
});
