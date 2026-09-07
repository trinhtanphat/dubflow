import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { ProjectExportRepository } from '../src/db/project-exports';

type Call = { sql: string; values: unknown[] };

class Db implements D1DatabaseLike {
  readonly calls: Call[] = [];
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

describe('project export Stream provenance', () => {
  it('persists the private render asset on exactly one owned export attempt', async () => {
    const db = new Db();
    const repo = new ProjectExportRepository(db);

    await repo.setStreamProvenance(
      'p1',
      'export-1',
      'u1',
      'projects/p1/source/a.mp4',
      'stream-render-export-1',
    );

    const update = db.calls.find((call) => /UPDATE project_exports/i.test(call.sql));
    expect(update?.sql).toMatch(/stream_video_uid\s*=\s*\?/i);
    expect(update?.sql).toMatch(/stream_source_object_key\s*=\s*\?/i);
    expect(update?.sql).toMatch(/WHERE id = \? AND project_id = \?/i);
    expect(update?.values).toEqual([
      'stream-render-export-1',
      'projects/p1/source/a.mp4',
      'export-1',
      'p1',
    ]);
  });
});
