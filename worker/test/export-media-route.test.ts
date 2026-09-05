import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createExportRoutes } from '../src/routes/export';

function stream(bytes: number[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.from(bytes)); controller.close(); } });
}

function completedProject() {
  return {
    id: 'p1', userId: 'dev-user', status: 'completed', sourceObjectKey: 'projects/p1/source/a.mp4',
    exportObjectKey: 'projects/p1/export/dubbed.mp4',
  };
}

describe('export media route', () => {
  it('streams the owned durable final MP4 from R2', async () => {
    const projects = {
      async getByIdForUser() { return completedProject(); },
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
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('content-length')).toBe('3');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it('streams only the requested final MP4 byte range', async () => {
    const getOptions: unknown[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({ async getByIdForUser() { return completedProject(); } }) as never,
      makeJobs: () => ({}) as never,
      makeBucket: () => ({
        async head(key: string) {
          expect(key).toBe('projects/p1/export/dubbed.mp4');
          return { key, size: 4, httpMetadata: { contentType: 'video/mp4' }, httpEtag: 'etag-1' };
        },
        async get(key: string, options?: unknown) {
          expect(key).toBe('projects/p1/export/dubbed.mp4');
          getOptions.push(options);
          return { key, size: 4, body: stream(options ? [20, 30] : [10, 20, 30, 40]), httpMetadata: { contentType: 'video/mp4' }, httpEtag: 'etag-1' };
        },
      }) as never,
    }));

    const response = await app.request('/api/projects/p1/export/media', { headers: { Range: 'bytes=1-2' } }, {} as Env);
    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
    expect(response.headers.get('content-length')).toBe('2');
    expect(response.headers.get('content-disposition')).toContain('p1-dubbed.mp4');
    expect(getOptions).toEqual([{ range: { offset: 1, length: 2 } }]);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([20, 30]);
  });

  it('returns 416 for an unsatisfiable final MP4 byte range without reading the body', async () => {
    let bodyRead = false;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({ async getByIdForUser() { return completedProject(); } }) as never,
      makeJobs: () => ({}) as never,
      makeBucket: () => ({
        async head() { return { key: 'projects/p1/export/dubbed.mp4', size: 4 }; },
        async get() { bodyRead = true; return null; },
      }) as never,
    }));

    const response = await app.request('/api/projects/p1/export/media', { headers: { Range: 'bytes=9-10' } }, {} as Env);
    expect(response.status).toBe(416);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes */4');
    expect(bodyRead).toBe(false);
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
