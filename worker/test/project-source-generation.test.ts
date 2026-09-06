import { describe, expect, it } from 'vitest';
import { ProjectRepository, type D1DatabaseLike, type D1RunResultLike, type D1StatementLike } from '../src/db/projects';

type Call = { sql: string; values: unknown[] };

class RecordingDb implements D1DatabaseLike {
  readonly calls: Call[] = [];
  prepare(sql: string): D1StatementLike {
    return new RecordingStatement(this, sql);
  }
}

class RecordingStatement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private readonly db: RecordingDb, private readonly sql: string) {}
  bind(...values: unknown[]): D1StatementLike {
    this.values = values;
    return this;
  }
  async run(): Promise<D1RunResultLike> {
    this.db.calls.push({ sql: this.sql, values: this.values });
    return { meta: { changes: 1 } };
  }
  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] };
  }
  async first<T>(): Promise<T | null> {
    return null;
  }
}

describe('project source generation', () => {
  it('starts a new project at source generation 1', async () => {
    const repo = new ProjectRepository(new RecordingDb());
    const project = await repo.create('u1', { title: 'Episode', sourceLanguage: 'zh', targetLanguage: 'vi' });
    expect(project.sourceGeneration).toBe(1);
  });

  it('advances generation only when a different durable source replaces the current source', async () => {
    const db = new RecordingDb();
    const repo = new ProjectRepository(db);

    await repo.setSourceObject('p1', 'u1', 'projects/p1/source/source-a.mp4', 42);

    const update = db.calls.at(-1);
    expect(update?.sql).toMatch(/source_generation\s*=\s*CASE/i);
    expect(update?.sql).toMatch(/source_object_key\s+IS\s+NULL\s+OR\s+source_object_key\s*=\s*\?/i);
    expect(update?.sql).toMatch(/ELSE\s+source_generation\s*\+\s*1/i);
    expect(update?.values).toEqual([
      'projects/p1/source/source-a.mp4',
      'projects/p1/source/source-a.mp4',
      42,
      'p1',
      'u1',
    ]);
  });
});
