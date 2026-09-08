import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { ClientInferenceRepository } from '../src/db/client-inference';
import { LOCAL_INFERENCE_ASR, LOCAL_INFERENCE_TRANSLATION, normalizeClientInferenceInput } from '../src/domain/client-inference';
import { createProjectsRoutes } from '../src/routes/projects';

class BusyStatement implements D1StatementLike {
  constructor(private readonly sql: string) {}

  bind(..._values: unknown[]): D1StatementLike {
    return new BusyStatement(this.sql);
  }

  async run(): Promise<D1RunResultLike> {
    return { changes: 0 };
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] };
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM projects')) {
      return {
        id: 'p1',
        source_language: 'en',
        target_language: 'vi',
        source_generation: 3,
        source_object_key: 'projects/p1/source/current.mp4',
        duration_ms: 1_000,
        size_bytes: 1_024,
        status: 'processing',
        translation_context_revision: 1,
      } as T;
    }
    return null;
  }
}

class BusyD1 implements D1DatabaseLike {
  prepare(sql: string): D1StatementLike {
    return new BusyStatement(sql);
  }
}

function input() {
  return normalizeClientInferenceInput('p1', {
    expectedSourceGeneration: 3,
    expectedSourceObjectKey: 'projects/p1/source/current.mp4',
    durationMs: 1_000,
    asr: { ...LOCAL_INFERENCE_ASR },
    translation: { ...LOCAL_INFERENCE_TRANSLATION },
    segments: [{ id: 's1', startMs: 0, endMs: 1_000, sourceText: 'Hello' }],
    translations: [{ segmentId: 's1', translatedText: 'Xin chào' }],
  });
}

describe('browser-local busy admission contract', () => {
  it('uses LOCAL_INFERENCE_BUSY for repository admission while performing zero writes', async () => {
    const repository = new ClientInferenceRepository(new BusyD1());
    await expect(repository.commit('p1', 'u1', input())).rejects.toMatchObject({
      code: 'LOCAL_INFERENCE_BUSY',
    });
  });

  it('maps busy admission to HTTP 409 LOCAL_INFERENCE_BUSY', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProjectsRoutes());
    const response = await app.request('/api/projects/p1/client-inference/vi', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    }, { DB: new BusyD1() } as unknown as Env);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: true,
      code: 'LOCAL_INFERENCE_BUSY',
    });
  });
});
