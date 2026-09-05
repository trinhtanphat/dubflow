import { describe, expect, it } from 'vitest';
import app from '../src/app';

describe('GET /api/health', () => {
  it('returns DubFlow foundation health', async () => {
    const response = await app.fetch(
      new Request('https://dubflow.test/api/health'),
      { ASSETS: { fetch: async () => new Response('asset') } } as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'dubflow', phase: 'foundation' });
  });
});
