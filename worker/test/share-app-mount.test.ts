import { describe, expect, it } from 'vitest';
import app from '../src/app';

function env() {
  const statement = {
    bind(..._values: unknown[]) { return this; },
    async first<T>() { return null as T | null; },
    async all<T>() { return { results: [] as T[] }; },
    async run() { return { meta: { changes: 0 } }; },
  };
  return {
    DB: { prepare() { return statement; } },
    MEDIA: {
      async get() { return null; },
      async head() { return null; },
    },
    ANALYTICS: { writeDataPoint() {} },
    ASSETS: { fetch: async () => new Response('asset fallback', { status: 200 }) },
  } as never;
}

describe('Phase 3C sharing app mounts', () => {
  it('mounts owner share management under /api/projects', async () => {
    const response = await app.fetch(
      new Request('https://dubflow.test/api/projects/p1/shares'),
      env(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: true,
      code: 'PROJECT_NOT_FOUND',
    });
  });

  it('mounts anonymous shared media under /api without falling through to assets', async () => {
    const response = await app.fetch(
      new Request('https://dubflow.test/api/shares/s1/media?token=wrong'),
      env(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: true,
      code: 'SHARE_NOT_FOUND',
      message: 'Share not found.',
    });
  });
});
