import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { ProjectExportRepository } from '../src/db/project-exports';

class MixDb implements D1DatabaseLike {
  prepare(sql: string): D1StatementLike { return new MixStatement(sql); }
}

class MixStatement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private readonly sql: string) {}
  bind(...values: unknown[]): D1StatementLike { this.values = values; return this; }
  async run(): Promise<D1RunResultLike> { return { meta: { changes: 1 } }; }
  async all<T>(): Promise<{ results?: T[] }> { return { results: [] }; }
  async first<T>(): Promise<T | null> {
    if (/SELECT id FROM projects/i.test(this.sql)) return { id: String(this.values[0]) } as T;
    return null;
  }
}

describe('Phase 4D project export mix provenance', () => {
  it('persists preserve_background on a dubbed export attempt', async () => {
    const repo = new ProjectExportRepository(new MixDb(), () => 'exp-1');
    const created = await (repo.create as any)('p1', 'u1', 'ja', 'dubbed', null, 'preserve_background');
    expect(created).toMatchObject({
      id: 'exp-1',
      targetLanguage: 'ja',
      output: 'dubbed',
      mixMode: 'preserve_background',
    });
  });
});
