import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { Project, ProjectStore } from '../src/db/projects';
import { createMediaRoutes } from '../src/routes/media';

class MemoryProjectStore implements ProjectStore {
  constructor(private project: Project | null) {}
  async create(): Promise<Project> { throw new Error('unused'); }
  async listByUser(): Promise<Project[]> { return this.project ? [this.project] : []; }
  async getByIdForUser(id: string, userId: string): Promise<Project | null> {
    return this.project?.id === id && this.project.userId === userId ? this.project : null;
  }
  async setSourceObject() {}
}

class MemoryBucket {
  constructor(private readonly bytes = new Uint8Array([1, 2, 3, 4, 5, 6])) {}
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    if (key !== 'projects/project-1/source/source.mp4') return null;
    const range = options?.range;
    const selected = range ? this.bytes.slice(range.offset, range.offset + range.length) : this.bytes;
    return {
      key,
      size: this.bytes.byteLength,
      range,
      httpEtag: '"etag-source"',
      httpMetadata: { contentType: 'video/mp4' },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(selected); controller.close(); } }),
    };
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    userId: 'dev-user',
    title: 'Episode',
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
    status: 'ready',
    sourceObjectKey: 'projects/project-1/source/source.mp4',
    sizeBytes: 6,
    ...overrides,
  };
}

function makeApp(project: Project | null, bucket = new MemoryBucket()) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createMediaRoutes(() => new MemoryProjectStore(project), () => bucket));
  return app;
}

describe('private media route', () => {
  it('returns 404 when the project is not owned by the current user', async () => {
    const response = await makeApp(makeProject({ userId: 'other-user' })).request('/api/projects/project-1/media');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: true, code: 'PROJECT_NOT_FOUND' });
  });

  it('returns 409 when the owned project has no source object yet', async () => {
    const response = await makeApp(makeProject({ sourceObjectKey: null, sizeBytes: null })).request('/api/projects/project-1/media');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: true, code: 'MEDIA_NOT_READY' });
  });

  it('returns 200 with byte-range capability for a full object request', async () => {
    const response = await makeApp(makeProject()).request('/api/projects/project-1/media');
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('content-length')).toBe('6');
    expect(response.headers.get('etag')).toBe('"etag-source"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('returns 206 with Content-Range for bytes=2-4', async () => {
    const response = await makeApp(makeProject()).request('/api/projects/project-1/media', { headers: { range: 'bytes=2-4' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 2-4/6');
    expect(response.headers.get('content-length')).toBe('3');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5]));
  });

  it('returns 416 for an unsatisfied Range request', async () => {
    const response = await makeApp(makeProject()).request('/api/projects/project-1/media', { headers: { range: 'bytes=9-10' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */6');
  });
});
