import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { ProjectExportRepository } from '../src/db/project-exports';

type Call = { sql: string; values: unknown[] };

class Db implements D1DatabaseLike {
  calls: Call[] = [];
  prepare(sql: string): D1StatementLike { return new Statement(this, sql); }
}

class Statement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private readonly db: Db, private readonly sql: string) {}
  bind(...values: unknown[]): D1StatementLike { this.values = values; return this; }
  async first<T>(): Promise<T | null> {
    if (/SELECT id FROM projects/i.test(this.sql)) return { id: 'p1' } as T;
    return null;
  }
  async run(): Promise<D1RunResultLike> {
    this.db.calls.push({ sql: this.sql, values: this.values });
    return { meta: { changes: 1 } };
  }
  async all<T>(): Promise<{ results?: T[] }> { return { results: [] }; }
}

describe('Phase 4E immutable export visual intent', () => {
  it('persists requested visual processing on the initial export row', async () => {
    const db = new Db();
    const repo = new ProjectExportRepository(db, () => 'e1');
    const created = await repo.create('p1', 'u1', 'vi', 'dubbed', null, 'dubbed_only', true);

    expect(created).toMatchObject({
      id: 'e1',
      lipSyncRequested: true,
      lipSyncStatus: 'queued',
    });
    const insert = db.calls.find((call) => /INSERT INTO project_exports/i.test(call.sql));
    expect(insert?.sql).toMatch(/lip_sync_requested/i);
    expect(insert?.sql).toMatch(/lip_sync_status/i);
    expect(insert?.values).toEqual(['e1', 'p1', 'vi', 'dubbed', null, 'dubbed_only', 1, 'queued']);
  });

  it('keeps subtitle attempts visual-standard even if a caller passes true defensively', async () => {
    const db = new Db();
    const repo = new ProjectExportRepository(db, () => 'e2');
    const created = await repo.create('p1', 'u1', 'vi', 'subtitles', null, 'dubbed_only', true);
    expect(created).toMatchObject({ lipSyncRequested: false, lipSyncStatus: 'not_requested' });
  });
});
