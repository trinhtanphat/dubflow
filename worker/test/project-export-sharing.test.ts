import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { ProjectExport } from '../src/db/project-exports';
import type { CreateExportShareInput, ExportShare, ShareStore } from '../src/db/shares';
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

function attempt(overrides: Partial<ProjectExport> = {}): ProjectExport {
  return {
    id: 'vi-exp', projectId: 'p1', targetLanguage: 'vi', output: 'dubbed', batchId: null,
    mixMode: 'dubbed_only', status: 'completed', exportObjectKey: 'projects/p1/exports/vi/vi-exp.mp4', subtitleObjectKey: null,
    errorCode: null, errorMessage: null, ...overrides,
  };
}

function share(input: CreateExportShareInput): ExportShare {
  return {
    id: 'share-1', projectId: input.projectId, exportId: input.exportId ?? null,
    tokenHint: input.tokenHint, exportObjectKey: input.exportObjectKey,
    expiresAt: input.expiresAt, revokedAt: null, createdAt: NOW.toISOString(), status: 'active',
  };
}

function projectStore() {
  return { async getByIdForUser(id: string, userId: string) {
    expect(id).toBe('p1');
    expect(userId).toBe('dev-user');
    return project();
  } };
}

function shareStore(onCreate: (input: CreateExportShareInput) => void): ShareStore {
  return {
    async create(input) { onCreate(input); return share(input); },
    async listForProject() { return []; },
    async revoke() { return null; },
    async resolveActive() { return null; },
  };
}

function appWith(exportsStore: { get: (...args: any[]) => Promise<ProjectExport | null>; latestCompleted: (...args: any[]) => Promise<ProjectExport | null> }, onCreate: (input: CreateExportShareInput) => void) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createProjectShareRoutes({
    makeProjects: () => projectStore() as never,
    makeExports: () => exportsStore as never,
    makeShares: () => shareStore(onCreate),
    createToken: async () => ({ token: 'plain', tokenHash: 'hash', tokenHint: 'hint' }),
    now: () => new Date(NOW),
  }));
  return app;
}

describe('canonical Phase 4C export sharing', () => {
  it('binds an explicit completed target export and rejects an incomplete attempt', async () => {
    const ja = attempt({ id: 'ja-exp', targetLanguage: 'ja', exportObjectKey: 'projects/p1/exports/ja/ja-exp.mp4' });
    const queued = attempt({ id: 'queued-exp', targetLanguage: 'en', status: 'pending', exportObjectKey: null });
    let created: CreateExportShareInput | null = null;
    const app = appWith({
      async get(_projectId, exportId) { return exportId === 'ja-exp' ? ja : exportId === 'queued-exp' ? queued : null; },
      async latestCompleted() { return null; },
    }, (input) => { created = input; });

    const ok = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exportId: 'ja-exp' }),
    }, {} as Env);
    expect(ok.status).toBe(201);
    expect(created).toMatchObject({ exportId: 'ja-exp', exportObjectKey: 'projects/p1/exports/ja/ja-exp.mp4' });

    const notReady = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exportId: 'queued-exp' }),
    }, {} as Env);
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({ code: 'EXPORT_NOT_READY' });
  });

  it('attaches the matching completed Vietnamese attempt to legacy share creation', async () => {
    let created: CreateExportShareInput | null = null;
    const vi = attempt();
    const app = appWith({
      async get() { return null; },
      async latestCompleted() { return vi; },
    }, (input) => { created = input; });

    const response = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, {} as Env);
    expect(response.status).toBe(201);
    expect(created).toMatchObject({ exportId: 'vi-exp', exportObjectKey: 'projects/p1/exports/vi/vi-exp.mp4' });
  });
});