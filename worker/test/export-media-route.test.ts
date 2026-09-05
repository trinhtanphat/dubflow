import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';

function stream(bytes: number[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.from(bytes)); controller.close(); } });
}

describe('export media route', () => {
  it('streams the owned durable final MP4 from R2', async () => {
    const projects = {
      async getByIdForUser() {
        return {
          id: 'p1', userId: 'dev-user', status: 'completed', sourceObjectKey: 'projects/p1/source/a.mp4',
          exportObjectKey: 'projects/p1/export/dubbed.mp4',
        };
      },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => projects as never,
      makeJobs: () => ({}) as never,
      makeBucket: () => ({
        async get(key: string) {
          expect(key).toBe('projects/p1/export/dubbed.mp4');
          return { key, size: 3, body: stream([1, 2, 3]), httpMetadata: { contentType: 'video/mp4' } };
        },
      }),
    }));

    const response = await app.request('/api/projects/p1/export/media', {}, {} as Env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('content-length')).toBe('3');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it('returns 409 until a final export object has been published', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() { return { id: 'p1', userId: 'dev-user', status: 'needs_review', exportObjectKey: null }; },
      }) as never,
      makeJobs: () => ({}) as never,
      makeBucket: () => ({ async get() { throw new Error('must not read'); } }),
    }));

    const response = await app.request('/api/projects/p1/export/media', {}, {} as Env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'EXPORT_NOT_READY' });
  });
});
