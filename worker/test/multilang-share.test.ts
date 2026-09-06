import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { ExportVariant, MultilangStore } from '../src/db/multilang';
import type { CreateExportShareInput, ExportShare, ShareStore } from '../src/db/shares';
import { createExportRoutes } from '../src/routes/export';
import { createProjectShareRoutes } from '../src/routes/shares';

const NOW = new Date('2026-09-06T00:00:00.000Z');

function project() {
  return {
    id: 'p1', userId: 'dev-user', title: 'Episode', sourceLanguage: 'en' as const,
    targetLanguage: 'vi' as const, status: 'completed' as const,
    sourceObjectKey: 'projects/p1/source/a.mp4',
    exportObjectKey: 'projects/p1/exports/vi/vi-exp.mp4',
  };
}

function variant(overrides: Partial<ExportVariant> = {}): ExportVariant {
  return {
    id: 'vi-exp', projectId: 'p1', batchId: 'batch-1', targetLanguage: 'vi',
    status: 'completed', objectKey: 'projects/p1/exports/vi/vi-exp.mp4',
    jobId: 'job-1', errorCode: null, generation: 1,
    ...overrides,
  };
}

function share(input: CreateExportShareInput): ExportShare {
  return {
    id: 'share-1', projectId: input.projectId, exportId: input.exportId ?? null,
    tokenHint: input.tokenHint, exportObjectKey: input.exportObjectKey,
    expiresAt: input.expiresAt, revokedAt: null, createdAt: NOW.toISOString(), status: 'active',
  };
}

function multilangStore(overrides: Partial<MultilangStore> = {}): MultilangStore {
  return {
    async listTargets() { return ['vi']; },
    async replaceTargets(_projectId, _userId, targets) { return targets; },
    async getTranslation() { return null; },
    async upsertTranslation(input) { return input; },
    async getDub() { return null; },
    async upsertDub(input) { return input; },
    async invalidateSegmentAllTargets() {},
    async invalidateSegmentTarget() {},
    async invalidateSpeakerAllTargets() {},
    async createExport(input) { return variant({ id: input.id, batchId: input.batchId, targetLanguage: input.targetLanguage, jobId: input.jobId, generation: input.generation, status: 'queued', objectKey: null }); },
    async getExport() { return null; },
    async listExports() { return []; },
    async listBatchExports() { return []; },
    async setExportRunning() {},
    async completeExport() {},
    async failExport() {},
    async cancelExport() {},
    async invalidateExportsForTarget() {},
    ...overrides,
  };
}

function projectStore() {
  return { async getByIdForUser(id: string, userId: string) {
    expect(id).toBe('p1');
    expect(userId).toBe('dev-user');
    return project();
  } };
}

function stream(bytes: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.from(bytes)); controller.close(); },
  });
}

describe('Phase 4C concrete export sharing', () => {
  it('binds legacy Vietnamese share creation to the current completed VI export variant when one exists', async () => {
    let createInput: CreateExportShareInput | null = null;
    const currentVi = variant();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProjectShareRoutes({
      makeProjects: () => projectStore() as never,
      makeMultilang: () => multilangStore({
        async listExports(projectId, userId) {
          expect(projectId).toBe('p1');
          expect(userId).toBe('dev-user');
          return [currentVi];
        },
      }),
      makeShares: () => ({
        async create(input) { createInput = input; return share(input); },
        async listForProject() { return []; },
        async revoke() { return null; },
        async resolveActive() { return null; },
      } as ShareStore),
      createToken: async () => ({ token: 'plain', tokenHash: 'hash', tokenHint: 'hint' }),
      now: () => new Date(NOW),
    }));

    const response = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, {} as Env);

    expect(response.status).toBe(201);
    expect(createInput).toMatchObject({
      exportId: 'vi-exp',
      exportObjectKey: 'projects/p1/exports/vi/vi-exp.mp4',
    });
  });

  it('binds an explicit completed non-VI variant and rejects incomplete variants', async () => {
    const ja = variant({ id: 'ja-exp', targetLanguage: 'ja', objectKey: 'projects/p1/exports/ja/ja-exp.mp4' });
    let created: CreateExportShareInput | null = null;
    const store = multilangStore({ async getExport(_projectId, exportId) {
      if (exportId === 'ja-exp') return ja;
      if (exportId === 'queued-exp') return variant({ id: 'queued-exp', targetLanguage: 'en', status: 'running', objectKey: null });
      return null;
    } });
    const shares: ShareStore = {
      async create(input) { created = input; return share(input); },
      async listForProject() { return []; },
      async revoke() { return null; },
      async resolveActive() { return null; },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProjectShareRoutes({
      makeProjects: () => projectStore() as never,
      makeMultilang: () => store,
      makeShares: () => shares,
      createToken: async () => ({ token: 'plain', tokenHash: 'hash', tokenHint: 'hint' }),
      now: () => new Date(NOW),
    }));

    const ok = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exportId: 'ja-exp' }),
    }, {} as Env);
    expect(ok.status).toBe(201);
    expect(created).toMatchObject({ exportId: 'ja-exp', exportObjectKey: 'projects/p1/exports/ja/ja-exp.mp4' });

    const incomplete = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exportId: 'queued-exp' }),
    }, {} as Env);
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({ code: 'EXPORT_NOT_READY' });
  });

  it('streams a concrete owner variant with the same byte-range semantics as legacy media', async () => {
    const getOptions: unknown[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => projectStore() as never,
      makeJobs: () => ({}) as never,
      makeMultilang: () => multilangStore({
        async getExport() { return variant({ id: 'ja-exp', targetLanguage: 'ja', objectKey: 'projects/p1/exports/ja/ja-exp.mp4' }); },
      }),
      makeBucket: () => ({
        async head(key: string) {
          expect(key).toBe('projects/p1/exports/ja/ja-exp.mp4');
          return { key, size: 4, httpMetadata: { contentType: 'video/mp4' }, httpEtag: 'etag-ja' };
        },
        async get(key: string, options?: unknown) {
          expect(key).toBe('projects/p1/exports/ja/ja-exp.mp4');
          getOptions.push(options);
          return { key, size: 4, body: stream([20, 30]), httpMetadata: { contentType: 'video/mp4' }, httpEtag: 'etag-ja' };
        },
      }) as never,
    }));

    const response = await app.request('/api/projects/p1/exports/ja-exp/media', {
      headers: { Range: 'bytes=1-2' },
    }, {} as Env);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
    expect(response.headers.get('content-length')).toBe('2');
    expect(response.headers.get('content-disposition')).toContain('p1-ja-dubbed.mp4');
    expect(getOptions).toEqual([{ range: { offset: 1, length: 2 } }]);
  });
});
