import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ShareRepository, type ExportShare } from '../src/db/shares';
import { createShareToken, hashShareToken } from '../src/security/share-token';

const migration = readFileSync(new URL('../../migrations/0006_export_shares.sql', import.meta.url), 'utf8');

type Row = {
  id: string;
  project_id: string;
  created_by_user_id: string;
  token_hash: string;
  token_hint: string;
  export_object_key: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 's1',
    project_id: 'p1',
    created_by_user_id: 'u1',
    token_hash: 'hash-active',
    token_hint: 'hint1234',
    export_object_key: 'projects/p1/export/final.mp4',
    expires_at: '2026-09-20T00:00:00.000Z',
    revoked_at: null,
    created_at: '2026-09-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('share token cryptography', () => {
  it('generates at least 256 bits of base64url entropy and hashes deterministically', async () => {
    const first = await createShareToken();
    const second = await createShareToken();

    expect(first.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(first.token, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHint).toBe(first.token.slice(-8));
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(hashShareToken(first.token)).resolves.toBe(first.tokenHash);
    await expect(hashShareToken(first.token)).resolves.toBe(first.tokenHash);
  });
});

describe('export share migration', () => {
  it('stores only a unique token hash with expiry and revocation metadata', () => {
    expect(migration).toMatch(/CREATE TABLE export_shares/i);
    expect(migration).toMatch(/token_hash TEXT NOT NULL UNIQUE/i);
    expect(migration).toMatch(/expires_at TEXT NOT NULL/i);
    expect(migration).toMatch(/revoked_at TEXT/i);
    expect(migration).not.toMatch(/plaintext|raw_token|token_secret/i);
  });
});

describe('ShareRepository', () => {
  it('never binds the plaintext token when creating a share', async () => {
    const secret = await createShareToken();
    const bound: unknown[][] = [];
    const inserted = row({ token_hash: secret.tokenHash, token_hint: secret.tokenHint });
    const db = {
      prepare(statement: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; bound.push(next); return this; },
          async run() { return { meta: { changes: statement.includes('INSERT INTO export_shares') ? 1 : 0 } }; },
          async first<T>() { return (statement.includes('FROM export_shares') ? inserted : null) as T | null; },
          async all<T>() { return { results: [] as T[] }; },
        };
      },
    };

    const repo = new ShareRepository(db as never, () => 's1');
    const created = await repo.create({
      projectId: 'p1',
      userId: 'u1',
      tokenHash: secret.tokenHash,
      tokenHint: secret.tokenHint,
      exportObjectKey: 'projects/p1/export/final.mp4',
      expiresAt: '2026-09-20T00:00:00.000Z',
    });

    expect(created).toMatchObject({ id: 's1', projectId: 'p1', tokenHint: secret.tokenHint, status: 'active' });
    expect(bound.flat()).toContain(secret.tokenHash);
    expect(bound.flat()).not.toContain(secret.token);
    expect(Object.prototype.hasOwnProperty.call(created, 'tokenHash')).toBe(false);
  });

  it('lists owner-scoped rows with active, expired and revoked status but no token hash', async () => {
    const statements: string[] = [];
    const rows = [
      row({ id: 'active', token_hash: 'a', expires_at: '2026-09-20T00:00:00.000Z' }),
      row({ id: 'expired', token_hash: 'b', expires_at: '2026-09-01T00:00:00.000Z' }),
      row({ id: 'revoked', token_hash: 'c', revoked_at: '2026-09-05T00:00:00.000Z' }),
    ];
    const db = {
      prepare(statement: string) {
        statements.push(statement);
        return {
          bind(..._values: unknown[]) { return this; },
          async all<T>() { return { results: rows as T[] }; },
          async first<T>() { return null as T | null; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
    };

    const repo = new ShareRepository(db as never);
    const shares = await repo.listForProject('p1', 'u1', new Date('2026-09-06T00:00:00.000Z'));

    expect(shares.map((share) => [share.id, share.status])).toEqual([
      ['active', 'active'],
      ['expired', 'expired'],
      ['revoked', 'revoked'],
    ]);
    expect(shares.every((share) => !Object.prototype.hasOwnProperty.call(share, 'tokenHash'))).toBe(true);
    expect(statements.join('\n')).toMatch(/project_id\s*=\s*\?/i);
    expect(statements.join('\n')).toMatch(/created_by_user_id\s*=\s*\?/i);
  });

  it('requires both id and token hash and resolves only active unexpired rows', async () => {
    const statements: string[] = [];
    const db = {
      prepare(statement: string) {
        statements.push(statement);
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async first<T>() {
            const [shareId, tokenHash, now] = values as [string, string, string];
            if (shareId !== 'active' || tokenHash !== 'hash-active') return null;
            if (now >= '2026-09-20T00:00:00.000Z') return null;
            return row({ id: 'active', token_hash: 'hash-active' }) as T;
          },
          async all<T>() { return { results: [] as T[] }; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
    };

    const repo = new ShareRepository(db as never);
    await expect(repo.resolveActive('active', 'hash-active', new Date('2026-09-06T00:00:00.000Z')))
      .resolves.toMatchObject({ id: 'active', status: 'active' });
    await expect(repo.resolveActive('active', 'wrong', new Date('2026-09-06T00:00:00.000Z'))).resolves.toBeNull();
    await expect(repo.resolveActive('missing', 'hash-active', new Date('2026-09-06T00:00:00.000Z'))).resolves.toBeNull();
    await expect(repo.resolveActive('active', 'hash-active', new Date('2026-09-21T00:00:00.000Z'))).resolves.toBeNull();

    const sql = statements.join('\n');
    expect(sql).toMatch(/id\s*=\s*\?/i);
    expect(sql).toMatch(/token_hash\s*=\s*\?/i);
    expect(sql).toMatch(/revoked_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/expires_at\s*>\s*\?/i);
  });

  it('revokes idempotently inside the owner/project scope', async () => {
    const statements: string[] = [];
    let revokedAt: string | null = null;
    const db = {
      prepare(statement: string) {
        statements.push(statement);
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async run() {
            if (statement.includes('UPDATE export_shares')) revokedAt ??= String(values[0]);
            return { meta: { changes: 1 } };
          },
          async first<T>() {
            if (!statement.includes('FROM export_shares')) return null;
            return row({ revoked_at: revokedAt }) as T;
          },
          async all<T>() { return { results: [] as T[] }; },
        };
      },
    };

    const repo = new ShareRepository(db as never);
    const first = await repo.revoke('p1', 's1', 'u1', new Date('2026-09-06T12:00:00.000Z'));
    const second = await repo.revoke('p1', 's1', 'u1', new Date('2026-09-06T13:00:00.000Z'));

    expect(first?.status).toBe('revoked');
    expect(second?.status).toBe('revoked');
    expect(second?.revokedAt).toBe(first?.revokedAt);
    const sql = statements.join('\n');
    expect(sql).toMatch(/UPDATE export_shares/i);
    expect(sql).toMatch(/project_id\s*=\s*\?/i);
    expect(sql).toMatch(/created_by_user_id\s*=\s*\?/i);
    expect(sql).toMatch(/COALESCE\s*\(\s*revoked_at/i);
  });

  it('exposes the owner-facing type without token hash material', () => {
    const share: ExportShare = {
      id: 's1', projectId: 'p1', tokenHint: 'hint1234', exportObjectKey: 'projects/p1/export/final.mp4',
      expiresAt: '2026-09-20T00:00:00.000Z', revokedAt: null, createdAt: '2026-09-06T00:00:00.000Z', status: 'active',
    };
    expect(Object.keys(share)).not.toContain('tokenHash');
  });
});
