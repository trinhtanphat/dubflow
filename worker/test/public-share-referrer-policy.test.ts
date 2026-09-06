import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { ShareStore } from '../src/db/shares';
import type { WorkerHonoEnv } from '../src/observability/requestTelemetry';
import { createPublicShareRoutes } from '../src/routes/shares';

describe('public share referrer policy', () => {
  it('prevents bearer-token URLs from leaking through the Referer header on shared media responses', async () => {
    const app = new Hono<WorkerHonoEnv>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'req-referrer');
      await next();
    });
    const shares: ShareStore = {
      async create() { throw new Error('not used'); },
      async listForProject() { return []; },
      async revoke() { return null; },
      async resolveActive() {
        return {
          id: 's1',
          projectId: 'p1',
          tokenHint: 'hint1234',
          exportObjectKey: 'projects/p1/export/final.mp4',
          expiresAt: '2026-09-13T00:00:00.000Z',
          revokedAt: null,
          createdAt: '2026-09-06T00:00:00.000Z',
          status: 'active',
        };
      },
    };
    app.route('/api', createPublicShareRoutes({
      makeShares: () => shares,
      makeBucket: () => ({
        async get(key) {
          return {
            key,
            size: 1,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.of(1));
                controller.close();
              },
            }),
            httpMetadata: { contentType: 'video/mp4' },
          };
        },
      }),
      makeTelemetry: () => ({ write() {} }),
      hashToken: async () => 'hash',
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    }));

    const response = await app.request(
      'https://studio.test/api/shares/s1/media?token=plain_secret',
      {},
      {} as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
