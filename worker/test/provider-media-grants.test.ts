import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';

type GrantRow = {
  id: string;
  project_id: string;
  object_key: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

class GrantDb implements D1DatabaseLike {
  readonly project = { id: 'p1', user_id: 'u1' };
  row: GrantRow | null = null;
  prepare(sql: string): D1StatementLike { return new GrantStatement(this, sql); }
}

class GrantStatement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private readonly db: GrantDb, private readonly sql: string) {}
  bind(...values: unknown[]): D1StatementLike { this.values = values; return this; }
  async run(): Promise<D1RunResultLike> {
    if (/INSERT INTO provider_media_grants/i.test(this.sql)) {
      const [id, projectId, objectKey, tokenHash, expiresAt] = this.values as [string, string, string, string, string];
      this.db.row = {
        id,
        project_id: projectId,
        object_key: objectKey,
        token_hash: tokenHash,
        expires_at: expiresAt,
        consumed_at: null,
        created_at: '2026-09-06T16:40:00.000Z',
      };
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async first<T>(): Promise<T | null> {
    if (/SELECT id FROM projects/i.test(this.sql)) {
      const [projectId, userId] = this.values as [string, string];
      return projectId === this.db.project.id && userId === this.db.project.user_id ? ({ id: projectId } as T) : null;
    }
    if (/FROM provider_media_grants/i.test(this.sql)) {
      const row = this.db.row;
      if (!row) return null;
      if (/token_hash = \?/i.test(this.sql)) {
        const [id, tokenHash, now] = this.values as [string, string, string];
        if (row.id !== id || row.token_hash !== tokenHash || row.expires_at <= now) return null;
      } else {
        const [id, projectId] = this.values as [string, string];
        if (row.id !== id || row.project_id !== projectId) return null;
      }
      return row as T;
    }
    return null;
  }
  async all<T>(): Promise<{ results?: T[] }> { return { results: [] }; }
}

describe('provider media grant repository', () => {
  it('persists only the token hash and resolves the exact unexpired project object', async () => {
    const modulePath = '../src/db/provider-media-grants';
    const loaded = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const Repository = loaded.ProviderMediaGrantRepository as new (
      db: D1DatabaseLike,
      makeId?: () => string,
    ) => {
      create(input: {
        projectId: string;
        userId: string;
        objectKey: string;
        tokenHash: string;
        expiresAt: string;
      }): Promise<Record<string, unknown>>;
      resolveActive(id: string, tokenHash: string, now?: Date): Promise<Record<string, unknown> | null>;
    };

    const db = new GrantDb();
    const repo = new Repository(db, () => 'grant-1');
    const tokenHash = 'a'.repeat(64);
    const objectKey = 'projects/p1/exports/vi/export-1.mp4';

    const created = await repo.create({
      projectId: 'p1',
      userId: 'u1',
      objectKey,
      tokenHash,
      expiresAt: '2026-09-06T17:00:00.000Z',
    });

    expect(created).toMatchObject({
      id: 'grant-1',
      projectId: 'p1',
      objectKey,
      expiresAt: '2026-09-06T17:00:00.000Z',
      consumedAt: null,
    });
    expect(created).not.toHaveProperty('tokenHash');

    await expect(repo.resolveActive(
      'grant-1',
      tokenHash,
      new Date('2026-09-06T16:45:00.000Z'),
    )).resolves.toMatchObject({ objectKey });
  });
});
