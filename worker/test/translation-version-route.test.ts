import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { createTranslationRoutes } from '../src/routes/translation';

type SegmentRow = {
  id: string; project_id: string; speaker_id: string | null; start_ms: number; end_ms: number;
  source_text: string; translated_text: string; translation_engine: string; translation_status: string;
  voice_status: string; version: number; split_parent_id: string | null;
};

class Statement implements D1StatementLike {
  values: unknown[] = [];
  constructor(private readonly db: FakeDb, readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async run(): Promise<D1RunResultLike> {
    if (this.sql.includes('UPDATE segments SET translated_text')) {
      this.db.translationWrites += 1;
      const translatedText = String(this.values[0]);
      const engine = String(this.values[1]);
      const expectedVersion = this.values.find((value) => typeof value === 'number') as number | undefined;
      if (expectedVersion !== undefined && expectedVersion !== this.db.segment.version) {
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
  async all<T>() { return { results: [] as T[] }; }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM projects WHERE id = ? AND user_id = ?')) {
      const [projectId, userId] = this.values;
      if (projectId !== 'p1' || userId !== 'dev-user') return null;
      return {
        id: 'p1', user_id: 'dev-user', title: 'demo', source_language: 'en', target_language: 'vi', status: 'needs_review',
      } as T;
    }
    if (this.sql.includes('FROM segments s JOIN projects p')) {
      const [projectId, segmentId, userId] = this.values;
      if (projectId !== 'p1' || segmentId !== 's1' || userId !== 'dev-user') return null;
      return { ...this.db.segment } as T;
    }
    return null;
  }
}

class FakeDb implements D1DatabaseLike {
  translationWrites = 0;
  segment: SegmentRow = {
    id: 's1', project_id: 'p1', speaker_id: null, start_ms: 0, end_ms: 1_000,
    source_text: 'hello', translated_text: 'server-new', translation_engine: 'workers-ai',
    translation_status: 'completed', voice_status: 'pending', version: 2, split_parent_id: null,
  };
  prepare(sql: string) { return new Statement(this, sql); }
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createTranslationRoutes());
  return app;
}

function envFor(db: FakeDb) {
  return {
    DB: db,
    AI: {
      async run() { return { translated_text: 'provider-result' }; },
    },
    GOOGLE_CLOUD_TRANSLATE_API_KEY: '',
  } as any;
}

describe('revision-aware retranslation route', () => {
  it('rejects a persisted provider result when the segment revision is stale', async () => {
    const db = new FakeDb();
    const response = await makeApp().request('/api/projects/p1/segments/s1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, mode: 'workers-ai' }),
    }, envFor(db));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'SEGMENT_VERSION_CONFLICT',
      segment: { id: 's1', version: 2, translatedText: 'server-new' },
    });
    expect(db.segment.translated_text).toBe('server-new');
  });

  it('compare mode never persists either provider result', async () => {
    const db = new FakeDb();
    const response = await makeApp().request('/api/projects/p1/segments/s1/retranslate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, mode: 'compare' }),
    }, envFor(db));

    expect(response.status).toBe(200);
    expect(db.translationWrites).toBe(0);
  });
});
