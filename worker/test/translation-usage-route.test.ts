import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { createTranslationRoutes } from '../src/routes/translation';

type UsageInput = {
  userId: string;
  projectId: string | null;
  jobId: string | null;
  kind: string;
  units: number;
  provider: string;
  idempotencyKey?: string;
};

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
      this.db.segment.translated_text = String(this.values[0]);
      this.db.segment.translation_engine = String(this.values[1]);
      this.db.segment.translation_status = 'completed';
      this.db.segment.version += 1;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
  async all<T>() { return { results: [] as T[] }; }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM projects WHERE id = ? AND user_id = ?')) {
      return {
        id: 'p1', user_id: 'dev-user', title: 'demo', source_language: 'en', target_language: 'vi', status: 'needs_review',
      } as T;
    }
    if (this.sql.includes('FROM segments s JOIN projects p')) return { ...this.db.segment } as T;
    return null;
  }
}

class FakeDb implements D1DatabaseLike {
  translationWrites = 0;
  segment: SegmentRow = {
    id: 's1', project_id: 'p1', speaker_id: null, start_ms: 0, end_ms: 1000,
    source_text: 'hello', translated_text: 'old', translation_engine: 'workers-ai',
    translation_status: 'completed', voice_status: 'pending', version: 2, split_parent_id: null,
  };
  prepare(sql: string) { return new Statement(this, sql); }
}

type UsageStore = { record(input: UsageInput): Promise<unknown> };
type UsageFactory = (env: Env) => UsageStore;
type TranslationFactory = (usageFactory?: UsageFactory) => ReturnType<typeof createTranslationRoutes>;

function makeApp(db: FakeDb, usage: UsageStore) {
  const app = new Hono<{ Bindings: Env }>();
  const factory = createTranslationRoutes as unknown as TranslationFactory;
  app.route('/api/projects', factory(() => usage));
  return app;
}

function envFor(db: FakeDb, aiRun: () => Promise<unknown> = async () => ({ translated_text: 'workers-result' })) {
  return {
    DB: db,
    AI: { run: aiRun },
    GOOGLE_CLOUD_TRANSLATE_API_KEY: 'test-key',
  } as any;
}

function request(body: string) {
  return new Request('https://yupvox.test/api/projects/p1/segments/s1/retranslate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 3B interactive translation usage', () => {
  it('records both providers after a successful compare request without persisting either result', async () => {
    const db = new FakeDb();
    const records: UsageInput[] = [];
    const usage = { async record(input: UsageInput) { records.push(input); return { inserted: true, event: input }; } };
    vi.stubGlobal('fetch', async () => Response.json({ data: { translations: [{ translatedText: 'google-result' }] } }));

    const response = await makeApp(db, usage).request(request(JSON.stringify({ expectedVersion: 2, mode: 'compare' })), undefined, envFor(db));

    expect(response.status).toBe(200);
    expect(db.translationWrites).toBe(0);
    expect(records).toHaveLength(2);
    expect(records.map(({ provider, kind, units }) => ({ provider, kind, units }))).toEqual([
      { provider: 'workers-ai', kind: 'translation_characters', units: 5 },
      { provider: 'google', kind: 'translation_characters', units: 5 },
    ]);
    expect(records.every((record) => record.userId === 'dev-user' && record.projectId === 'p1' && record.jobId === null)).toBe(true);
    expect(records[0].idempotencyKey).toMatch(/^request:.+:translation:workers-ai$/);
    expect(records[1].idempotencyKey).toMatch(/^request:.+:translation:google$/);
    expect(records[0].idempotencyKey).not.toBe(records[1].idempotencyKey);
  });

  it('returns USAGE_RECORD_FAILED and does not persist translation when metering fails after provider success', async () => {
    const db = new FakeDb();
    const usage = { async record() { throw new Error('ledger unavailable'); } };

    const response = await makeApp(db, usage).request(request(JSON.stringify({ expectedVersion: 2, mode: 'workers-ai' })), undefined, envFor(db));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'USAGE_RECORD_FAILED' });
    expect(db.translationWrites).toBe(0);
  });

  it('does not meter invalid JSON, stale versions, or provider failures', async () => {
    for (const scenario of ['invalid-json', 'stale', 'provider-failure'] as const) {
      const db = new FakeDb();
      const records: UsageInput[] = [];
      const usage = { async record(input: UsageInput) { records.push(input); return { inserted: true, event: input }; } };
      if (scenario === 'stale') db.segment.version = 3;
      const body = scenario === 'invalid-json'
        ? '{'
        : JSON.stringify({ expectedVersion: 2, mode: 'workers-ai' });
      const env = envFor(db, scenario === 'provider-failure'
        ? async () => { throw new Error('provider down'); }
        : undefined);

      const response = await makeApp(db, usage).request(request(body), undefined, env);
      expect(response.status).not.toBe(200);
      expect(records).toEqual([]);
      expect(db.translationWrites).toBe(0);
    }
  });

  it('rejects blank source text before provider work or metering', async () => {
    const db = new FakeDb();
    db.segment.source_text = '   ';
    const records: UsageInput[] = [];
    let providerCalls = 0;
    const usage = { async record(input: UsageInput) { records.push(input); return { inserted: true, event: input }; } };

    const response = await makeApp(db, usage).request(
      request(JSON.stringify({ expectedVersion: 2, mode: 'workers-ai' })),
      undefined,
      envFor(db, async () => { providerCalls += 1; return { translated_text: '' }; }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'TRANSLATION_TEXT_REQUIRED' });
    expect(providerCalls).toBe(0);
    expect(records).toEqual([]);
  });
});
