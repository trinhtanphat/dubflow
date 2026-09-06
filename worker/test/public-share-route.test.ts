import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { ExportShare, ShareStore } from '../src/db/shares';
import type { R2ReadableBucketLike } from '../src/cloudflare/r2';
import type { TelemetryEvent } from '../src/observability/telemetry';
import type { WorkerHonoEnv } from '../src/observability/requestTelemetry';
import { createPublicShareRoutes } from '../src/routes/shares';

const NOW = new Date('2026-09-06T00:00:00.000Z');
const RAW_TOKEN = 'plain_secret';
const TOKEN_HASH = 'hash-secret';

function bytes(values: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from(values));
      controller.close();
    },
  });
}

function activeShare(overrides: Partial<ExportShare> = {}): ExportShare {
  return {
    id: 's1',
    projectId: 'p1',
    tokenHint: 'n_secret',
    exportObjectKey: 'projects/p1/export/final.mp4',
    expiresAt: '2026-09-13T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function defaultBucket(): R2ReadableBucketLike {
  return {
    async get(key, options) {
      expect(key).toBe('projects/p1/export/final.mp4');
      expect(options).toBeUndefined();
      return {
        key,
        size: 4,
        body: bytes([1, 2, 3, 4]),
        httpMetadata: { contentType: 'video/mp4' },
      };
    },
  };
}

function publicApp(options: {
  resolve?: (shareId: string, tokenHash: string, now: Date) => Promise<ExportShare | null>;
  bucket?: R2ReadableBucketLike;
  events?: TelemetryEvent[];
} = {}) {
  const events = options.events ?? [];
  const shares = {
    async resolveActive(shareId: string, tokenHash: string, now: Date) {
      if (options.resolve) return options.resolve(shareId, tokenHash, now);
      return shareId === 's1' && tokenHash === TOKEN_HASH ? activeShare() : null;
    },
  };
  const app = new Hono<WorkerHonoEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-share');
    await next();
  });
  app.route('/api', createPublicShareRoutes({
    makeShares: () => shares as ShareStore,
    makeBucket: () => options.bucket ?? defaultBucket(),
    makeTelemetry: () => ({ write(event: TelemetryEvent) { events.push(event); } }),
    hashToken: async (token: string) => token === RAW_TOKEN ? TOKEN_HASH : `hash:${token}`,
    now: () => new Date(NOW),
  }));
  return { app, events };
}

describe('anonymous shared export media', () => {
  it('streams a valid share without owner identity and emits sanitized access/download telemetry', async () => {
    const { app, events } = publicApp();
    const response = await app.request(
      `https://studio.test/api/shares/s1/media?token=${RAW_TOKEN}`,
      {},
      {} as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-disposition')).toContain('p1-dubbed.mp4');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    expect(events).toEqual([
      expect.objectContaining({
        name: 'share_access', requestId: 'req-share', shareId: 's1', projectId: 'p1',
        accessMode: 'share', httpStatus: 200, status: 'success',
      }),
      expect.objectContaining({
        name: 'export_download', requestId: 'req-share', shareId: 's1', projectId: 'p1',
        accessMode: 'share', httpStatus: 200, rangeRequest: false, status: 'success',
      }),
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(serialized).not.toContain(TOKEN_HASH);
    expect(serialized).not.toContain('?token=');
  });

  it('preserves Range 206 semantics for a valid shared export', async () => {
    const getOptions: unknown[] = [];
    const bucket: R2ReadableBucketLike = {
      async head(key) { return { key, size: 4, httpMetadata: { contentType: 'video/mp4' } }; },
      async get(key, options) {
        getOptions.push(options);
        return { key, size: 2, body: bytes([2, 3]), httpMetadata: { contentType: 'video/mp4' } };
      },
    };
    const { app, events } = publicApp({ bucket });
    const response = await app.request(
      `https://studio.test/api/shares/s1/media?token=${RAW_TOKEN}`,
      { headers: { Range: 'bytes=1-2' } },
      {} as Env,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
    expect(getOptions).toEqual([{ range: { offset: 1, length: 2 } }]);
    expect(events).toEqual([
      expect.objectContaining({ name: 'share_access', shareId: 's1', httpStatus: 206, accessMode: 'share' }),
      expect.objectContaining({ name: 'export_download', shareId: 's1', httpStatus: 206, rangeRequest: true, accessMode: 'share' }),
    ]);
  });

  it('returns 416 for an invalid Range, records access, and does not count a download', async () => {
    let bodyRead = false;
    const bucket: R2ReadableBucketLike = {
      async head(key) { return { key, size: 4 }; },
      async get() { bodyRead = true; return null; },
    };
    const { app, events } = publicApp({ bucket });
    const response = await app.request(
      `https://studio.test/api/shares/s1/media?token=${RAW_TOKEN}`,
      { headers: { Range: 'bytes=9-10' } },
      {} as Env,
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */4');
    expect(bodyRead).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({ name: 'share_access', shareId: 's1', projectId: 'p1', httpStatus: 416, accessMode: 'share' }),
    ]);
    expect(events.some((event) => event.name === 'export_download')).toBe(false);
  });

  it.each([
    ['missing token', 'https://studio.test/api/shares/s1/media'],
    ['wrong token', 'https://studio.test/api/shares/s1/media?token=wrong'],
    ['unknown id', `https://studio.test/api/shares/unknown/media?token=${RAW_TOKEN}`],
    ['expired share', `https://studio.test/api/shares/expired/media?token=${RAW_TOKEN}`],
    ['revoked share', `https://studio.test/api/shares/revoked/media?token=${RAW_TOKEN}`],
  ])('returns the same SHARE_NOT_FOUND response for %s', async (_case, url) => {
    const { app } = publicApp({
      resolve: async (shareId, tokenHash) => {
        if (shareId !== 's1' || tokenHash !== TOKEN_HASH) return null;
        return null;
      },
    });
    const response = await app.request(url, {}, {} as Env);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: true, code: 'SHARE_NOT_FOUND', message: 'Share not found.' });
  });

  it('maps a missing durable R2 object to the same non-enumerating share 404', async () => {
    const { app } = publicApp({ bucket: { async get() { return null; } } });
    const response = await app.request(
      `https://studio.test/api/shares/s1/media?token=${RAW_TOKEN}`,
      {},
      {} as Env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: true, code: 'SHARE_NOT_FOUND', message: 'Share not found.' });
  });
});
