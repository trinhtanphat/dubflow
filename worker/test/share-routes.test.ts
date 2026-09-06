import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { CreateExportShareInput, ExportShare, ShareStore } from '../src/db/shares';
import { createProjectShareRoutes } from '../src/routes/shares';

const NOW = new Date('2026-09-06T00:00:00.000Z');

function exportedProject() {
  return {
    id: 'p1',
    userId: 'dev-user',
    title: 'Episode',
    sourceLanguage: 'en' as const,
    targetLanguage: 'vi' as const,
    status: 'completed' as const,
    sourceObjectKey: 'projects/p1/source/a.mp4',
    exportObjectKey: 'projects/p1/export/final.mp4',
  };
}

function share(overrides: Partial<ExportShare> = {}): ExportShare {
  return {
    id: 's1',
    projectId: 'p1',
    tokenHint: 't-secret',
    exportObjectKey: 'projects/p1/export/final.mp4',
    expiresAt: '2026-09-13T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function projectStore(project: ReturnType<typeof exportedProject> | null = exportedProject()) {
  return {
    async getByIdForUser(id: string, userId: string) {
      expect(id).toBe('p1');
      expect(userId).toBe('dev-user');
      return project;
    },
  };
}

function appWith(
  shares: Pick<ShareStore, 'create' | 'listForProject' | 'revoke'>,
  project: ReturnType<typeof exportedProject> | null = exportedProject(),
) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createProjectShareRoutes({
    makeProjects: () => projectStore(project) as never,
    makeShares: () => shares as ShareStore,
    createToken: async () => ({ token: 'plain_secret', tokenHash: 'hash-secret', tokenHint: 'n_secret' }),
    now: () => new Date(NOW),
  }));
  return app;
}

describe('owner export share management', () => {
  it('creates a 7-day share and returns its plaintext URL exactly once', async () => {
    let createInput: CreateExportShareInput | null = null;
    const shares = {
      async create(input: CreateExportShareInput) {
        createInput = input;
        return share({ tokenHint: input.tokenHint, expiresAt: input.expiresAt });
      },
      async listForProject() { return []; },
      async revoke() { return null; },
    };
    const app = appWith(shares);

    const response = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }, {} as Env);
    const body = await response.json() as { share: ExportShare; shareUrl: string; tokenHash?: string };

    expect(response.status).toBe(201);
    expect(createInput).toMatchObject({
      projectId: 'p1',
      userId: 'dev-user',
      tokenHash: 'hash-secret',
      tokenHint: 'n_secret',
      exportObjectKey: 'projects/p1/export/final.mp4',
      expiresAt: '2026-09-13T00:00:00.000Z',
    });
    expect(body.share).toMatchObject({ id: 's1', projectId: 'p1', tokenHint: 'n_secret', status: 'active' });
    expect(body.shareUrl).toBe('https://studio.test/api/shares/s1/media?token=plain_secret');
    expect(body.tokenHash).toBeUndefined();
    expect(JSON.stringify(body.share)).not.toContain('hash-secret');
  });

  it.each([3599, 2592001])('rejects out-of-range TTL %s before creating a share', async (ttl) => {
    let createCalls = 0;
    const app = appWith({
      async create() { createCalls += 1; return share(); },
      async listForProject() { return []; },
      async revoke() { return null; },
    });

    const response = await app.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expiresInSeconds: ttl }),
    }, {} as Env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'SHARE_TTL_INVALID' });
    expect(createCalls).toBe(0);
  });

  it('requires an owned published export before create/list access', async () => {
    const neverShares = {
      async create() { throw new Error('must not create'); },
      async listForProject() { throw new Error('must not list'); },
      async revoke() { throw new Error('must not revoke'); },
    };

    const missing = appWith(neverShares, null);
    const missingResponse = await missing.request('https://studio.test/api/projects/p1/shares', {}, {} as Env);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    const notExported = appWith(neverShares, { ...exportedProject(), exportObjectKey: null } as never);
    const notExportedResponse = await notExported.request('https://studio.test/api/projects/p1/shares', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, {} as Env);
    expect(notExportedResponse.status).toBe(409);
    expect(await notExportedResponse.json()).toMatchObject({ code: 'EXPORT_NOT_READY' });
  });

  it('lists only owner-safe metadata and never reconstructs a share URL', async () => {
    const rows = [share(), share({ id: 's2', tokenHint: 'deadbeef', status: 'revoked', revokedAt: '2026-09-06T01:00:00.000Z' })];
    const app = appWith({
      async create() { return share(); },
      async listForProject(projectId: string, userId: string) {
        expect(projectId).toBe('p1');
        expect(userId).toBe('dev-user');
        return rows;
      },
      async revoke() { return null; },
    });

    const response = await app.request('https://studio.test/api/projects/p1/shares', {}, {} as Env);
    const body = await response.json() as ExportShare[];
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('shareUrl');
    expect(serialized).not.toContain('/api/shares/');
  });

  it('revokes idempotently and returns 404 for an out-of-scope share', async () => {
    let firstRevokedAt: string | null = null;
    const app = appWith({
      async create() { return share(); },
      async listForProject() { return []; },
      async revoke(projectId: string, shareId: string, userId: string) {
        expect(projectId).toBe('p1');
        expect(userId).toBe('dev-user');
        if (shareId !== 's1') return null;
        firstRevokedAt ??= '2026-09-06T00:00:00.000Z';
        return share({ status: 'revoked', revokedAt: firstRevokedAt });
      },
    });

    const first = await app.request('https://studio.test/api/projects/p1/shares/s1', { method: 'DELETE' }, {} as Env);
    const second = await app.request('https://studio.test/api/projects/p1/shares/s1', { method: 'DELETE' }, {} as Env);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: 'revoked', revokedAt: '2026-09-06T00:00:00.000Z' });

    const outside = await app.request('https://studio.test/api/projects/p1/shares/other', { method: 'DELETE' }, {} as Env);
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ code: 'SHARE_NOT_FOUND' });
  });
});
