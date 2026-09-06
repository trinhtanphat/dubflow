import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { R2ReadableBucketLike } from '../src/cloudflare/r2';

const NOW = new Date('2026-09-06T17:00:00.000Z');
const TOKEN_HASH = 'a'.repeat(64);
const OBJECT_KEY = 'projects/p1/exports/ja/export-1.audio.wav';

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function bucket(): R2ReadableBucketLike {
  const body = 'abcdef';
  return {
    async head(key) {
      expect(key).toBe(OBJECT_KEY);
      return { key, size: body.length, httpMetadata: { contentType: 'audio/wav' }, httpEtag: 'etag-1' };
    },
    async get(key, options) {
      expect(key).toBe(OBJECT_KEY);
      const range = options?.range;
      const slice = range ? body.slice(range.offset, range.offset + range.length) : body;
      return {
        key,
        size: slice.length,
        body: stream(slice),
        httpMetadata: { contentType: 'audio/wav' },
        httpEtag: 'etag-1',
        ...(range ? { range } : {}),
      };
    },
  };
}

describe('provider media bearer route', () => {
  it('allows repeated successful Range reads while the exact grant is unexpired', async () => {
    const modulePath = '../src/routes/provider-media';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const markAccessed = vi.fn(async () => {});
    const resolveActive = vi.fn(async (grantId: string, tokenHash: string, now: Date) => {
      expect(grantId).toBe('grant-1');
      expect(tokenHash).toBe(TOKEN_HASH);
      expect(now.toISOString()).toBe(NOW.toISOString());
      return {
        id: 'grant-1',
        projectId: 'p1',
        objectKey: OBJECT_KEY,
        expiresAt: '2026-09-06T17:15:00.000Z',
        consumedAt: null,
        createdAt: '2026-09-06T17:00:00.000Z',
      };
    });
    const createProviderMediaRoutes = loaded.createProviderMediaRoutes as (deps: Record<string, unknown>) => Hono<{ Bindings: Env }>;
    const routes = createProviderMediaRoutes({
      makeGrants: () => ({ resolveActive, markAccessed }),
      makeBucket: () => bucket(),
      hashToken: vi.fn(async (token: string) => token === 'secret' ? TOKEN_HASH : 'b'.repeat(64)),
      now: () => new Date(NOW),
    });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api', routes);

    const first = await app.request('https://yupvox.qs3d.site/api/provider-media/grant-1?token=secret', {
      headers: { range: 'bytes=0-2' },
    }, {} as Env);
    expect(first.status).toBe(206);
    expect(await first.text()).toBe('abc');
    expect(first.headers.get('content-range')).toBe('bytes 0-2/6');
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');

    const second = await app.request('https://yupvox.qs3d.site/api/provider-media/grant-1?token=secret', {
      headers: { range: 'bytes=3-5' },
    }, {} as Env);
    expect(second.status).toBe(206);
    expect(await second.text()).toBe('def');
    expect(resolveActive).toHaveBeenCalledTimes(2);
    expect(markAccessed).toHaveBeenCalledTimes(2);
  });

  it('returns 404 without reading R2 for an invalid or expired bearer grant', async () => {
    const modulePath = '../src/routes/provider-media';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    let bucketReads = 0;
    const createProviderMediaRoutes = loaded.createProviderMediaRoutes as (deps: Record<string, unknown>) => Hono<{ Bindings: Env }>;
    const routes = createProviderMediaRoutes({
      makeGrants: () => ({
        resolveActive: vi.fn(async () => null),
        markAccessed: vi.fn(async () => {}),
      }),
      makeBucket: () => ({
        async head() { bucketReads += 1; return null; },
        async get() { bucketReads += 1; return null; },
      }),
      hashToken: vi.fn(async () => 'b'.repeat(64)),
      now: () => new Date(NOW),
    });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api', routes);

    const response = await app.request('https://yupvox.qs3d.site/api/provider-media/grant-1?token=wrong', {}, {} as Env);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(bucketReads).toBe(0);
  });

  it('does not record access for an unsatisfiable Range request', async () => {
    const modulePath = '../src/routes/provider-media';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const markAccessed = vi.fn(async () => {});
    const createProviderMediaRoutes = loaded.createProviderMediaRoutes as (deps: Record<string, unknown>) => Hono<{ Bindings: Env }>;
    const routes = createProviderMediaRoutes({
      makeGrants: () => ({
        resolveActive: vi.fn(async () => ({
          id: 'grant-1', projectId: 'p1', objectKey: OBJECT_KEY,
          expiresAt: '2026-09-06T17:15:00.000Z', consumedAt: null, createdAt: NOW.toISOString(),
        })),
        markAccessed,
      }),
      makeBucket: () => bucket(),
      hashToken: vi.fn(async () => TOKEN_HASH),
      now: () => new Date(NOW),
    });
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api', routes);

    const response = await app.request('https://yupvox.qs3d.site/api/provider-media/grant-1?token=secret', {
      headers: { range: 'bytes=99-100' },
    }, {} as Env);
    expect(response.status).toBe(416);
    expect(markAccessed).not.toHaveBeenCalled();
  });
});
