import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike, ProjectStore } from '../src/db/projects';
import { ClientInferenceRepository } from '../src/db/client-inference';
import { createProjectsRoutes } from '../src/routes/projects';
import {
  LOCAL_INFERENCE_ASR,
  LOCAL_INFERENCE_MAX_COMMIT_BYTES,
  LOCAL_INFERENCE_TRANSLATION,
  LocalInferenceInputError,
  normalizeClientInferenceInput,
} from '../src/domain/client-inference';

function validPayload() {
  return {
    expectedSourceGeneration: 3,
    expectedSourceObjectKey: 'projects/p1/source/current.mp4',
    durationMs: 4_000,
    asr: { ...LOCAL_INFERENCE_ASR },
    translation: { ...LOCAL_INFERENCE_TRANSLATION },
    segments: [
      { id: 's1', startMs: 0, endMs: 1_500, sourceText: ' Hello ' },
      { id: 's2', startMs: 1_500, endMs: 4_000, sourceText: 'world' },
    ],
    translations: [
      { segmentId: 's1', translatedText: ' Xin chào ' },
      { segmentId: 's2', translatedText: 'thế giới' },
    ],
  };
}

class FakeStatement implements D1StatementLike {
  constructor(
    private readonly owner: FakeD1,
    readonly sql: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    return new FakeStatement(this.owner, this.sql, values);
  }

  async run(): Promise<D1RunResultLike> {
    return { changes: 1 };
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] };
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM projects')) {
      if (this.owner.projectMissing) return null;
      return {
        id: 'p1',
        source_language: 'en',
        target_language: 'vi',
        source_generation: 3,
        source_object_key: 'projects/p1/source/current.mp4',
        duration_ms: null,
        size_bytes: 1024,
        status: 'ready',
        translation_context_revision: 1,
      } as T;
    }
    if (this.sql.includes('FROM project_target_languages')) {
      return { status: this.owner.targetStatus } as T;
    }
    if (this.sql.includes('COUNT(*) AS busy_count')) {
      return { busy_count: this.owner.busyExportCount } as T;
    }
    return null;
  }
}

class FakeD1 implements D1DatabaseLike {
  batchCalls = 0;
  statements: FakeStatement[] = [];
  projectMissing = false;
  targetStatus = 'ready';
  busyExportCount = 0;
  failBatch = false;

  prepare(sql: string): D1StatementLike {
    return new FakeStatement(this, sql);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    this.batchCalls += 1;
    if (this.failBatch) throw new Error('internal batch detail');
    this.statements = statements as FakeStatement[];
    return statements.map(() => ({ changes: 1 }));
  }
}

function routeApp(db: FakeD1) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createProjectsRoutes(() => ({} as ProjectStore)));
  return {
    app,
    env: { DB: db } as unknown as Env,
  };
}

describe('browser-local client inference request validation', () => {
  it('normalizes the exact approved EN→VI local inference payload', () => {
    const input = normalizeClientInferenceInput('p1', validPayload());
    expect(input.expectedSourceGeneration).toBe(3);
    expect(input.expectedSourceObjectKey).toBe('projects/p1/source/current.mp4');
    expect(input.durationMs).toBe(4_000);
    expect(input.asr).toEqual(LOCAL_INFERENCE_ASR);
    expect(input.translation).toEqual(LOCAL_INFERENCE_TRANSLATION);
    expect(input.segments).toEqual([
      { id: 's1', startMs: 0, endMs: 1_500, sourceText: 'Hello' },
      { id: 's2', startMs: 1_500, endMs: 4_000, sourceText: 'world' },
    ]);
    expect(input.translations).toEqual([
      { segmentId: 's1', translatedText: 'Xin chào' },
      { segmentId: 's2', translatedText: 'thế giới' },
    ]);
  });

  it('rejects malformed source identity, duration and model provenance', () => {
    expect(() => normalizeClientInferenceInput('p1', { ...validPayload(), expectedSourceGeneration: 0 }))
      .toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', { ...validPayload(), expectedSourceObjectKey: '   ' }))
      .toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', { ...validPayload(), durationMs: 300_001 }))
      .toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', {
      ...validPayload(),
      asr: { ...LOCAL_INFERENCE_ASR, revision: 'wrong' },
    })).toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', {
      ...validPayload(),
      translation: { ...LOCAL_INFERENCE_TRANSLATION, provider: 'workers-ai' },
    })).toThrow(LocalInferenceInputError);
  });

  it('rejects client speaker injection, short/overlapping/out-of-bounds or empty ASR segments', () => {
    const speaker = validPayload();
    speaker.segments = [{ ...speaker.segments[0], speakerId: 'attacker-speaker' } as never];
    speaker.translations = [{ segmentId: 's1', translatedText: 'Xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', speaker)).toThrow(LocalInferenceInputError);

    const short = validPayload();
    short.segments = [{ id: 's1', startMs: 0, endMs: 99, sourceText: 'hello' }];
    short.translations = [{ segmentId: 's1', translatedText: 'xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', short)).toThrow(LocalInferenceInputError);

    const overlap = validPayload();
    overlap.segments = [
      { id: 's1', startMs: 0, endMs: 2_000, sourceText: 'hello' },
      { id: 's2', startMs: 1_999, endMs: 4_000, sourceText: 'world' },
    ];
    expect(() => normalizeClientInferenceInput('p1', overlap)).toThrow(LocalInferenceInputError);

    const outOfBounds = validPayload();
    outOfBounds.segments = [{ id: 's1', startMs: 0, endMs: 4_001, sourceText: 'hello' }];
    outOfBounds.translations = [{ segmentId: 's1', translatedText: 'xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', outOfBounds)).toThrow(LocalInferenceInputError);

    const empty = validPayload();
    empty.segments = [];
    empty.translations = [];
    expect(() => normalizeClientInferenceInput('p1', empty)).toThrow(LocalInferenceInputError);
  });

  it('requires exactly one nonempty translation for every canonical segment', () => {
    const missing = validPayload();
    missing.translations = [{ segmentId: 's1', translatedText: 'xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', missing)).toThrow(LocalInferenceInputError);

    const duplicate = validPayload();
    duplicate.translations = [
      { segmentId: 's1', translatedText: 'xin chào' },
      { segmentId: 's1', translatedText: 'lặp' },
    ];
    expect(() => normalizeClientInferenceInput('p1', duplicate)).toThrow(LocalInferenceInputError);

    const unknown = validPayload();
    unknown.translations = [
      { segmentId: 's1', translatedText: 'xin chào' },
      { segmentId: 'other', translatedText: 'khác' },
    ];
    expect(() => normalizeClientInferenceInput('p1', unknown)).toThrow(LocalInferenceInputError);

    const blank = validPayload();
    blank.translations[1].translatedText = '   ';
    expect(() => normalizeClientInferenceInput('p1', blank)).toThrow(LocalInferenceInputError);
  });

  it('accepts a valid browser duration when canonical duration is not known yet', async () => {
    const db = new FakeD1();
    const repository = new ClientInferenceRepository(db);
    const result = await repository.commit('p1', 'u1', normalizeClientInferenceInput('p1', validPayload()));

    expect(db.batchCalls).toBe(1);
    expect(result.durationMs).toBe(4_000);
    const projectWrite = db.statements.find((statement) => statement.sql.includes('UPDATE projects'));
    expect(projectWrite?.values[0]).toBe(4_000);
  });
});

describe('PUT /api/projects/:id/client-inference/vi', () => {
  it('commits a valid browser-local payload and returns canonical state', async () => {
    const db = new FakeD1();
    const { app, env } = routeApp(db);
    const response = await app.request('/api/projects/p1/client-inference/vi', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPayload()),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId: 'p1',
      sourceGeneration: 3,
      sourceObjectKey: 'projects/p1/source/current.mp4',
      durationMs: 4_000,
      speaker: { id: 'browser-local:p1:speaker-1' },
    });
    expect(db.batchCalls).toBe(1);
  });

  it('rejects malformed input as LOCAL_INFERENCE_INVALID without mutation', async () => {
    const db = new FakeD1();
    const { app, env } = routeApp(db);
    const response = await app.request('/api/projects/p1/client-inference/vi', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validPayload(), segments: [], translations: [] }),
    }, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: true, code: 'LOCAL_INFERENCE_INVALID' });
    expect(db.batchCalls).toBe(0);
  });

  it('rejects an announced body over 2 MiB before any mutation', async () => {
    const db = new FakeD1();
    const { app, env } = routeApp(db);
    const response = await app.request('/api/projects/p1/client-inference/vi', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'content-length': String(LOCAL_INFERENCE_MAX_COMMIT_BYTES + 1),
      },
      body: JSON.stringify(validPayload()),
    }, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: true, code: 'LOCAL_INFERENCE_INVALID' });
    expect(db.batchCalls).toBe(0);
  });

  it('returns safe source metadata for a stale-source conflict', async () => {
    const db = new FakeD1();
    const { app, env } = routeApp(db);
    const response = await app.request('/api/projects/p1/client-inference/vi', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validPayload(), expectedSourceGeneration: 2 }),
    }, env);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: true,
      code: 'LOCAL_INFERENCE_SOURCE_CONFLICT',
      source: {
        sourceGeneration: 3,
        sourceObjectKey: 'projects/p1/source/current.mp4',
      },
    });
    expect(db.batchCalls).toBe(0);
  });
});
