import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { ProjectExportRepository, type ProjectExport } from '../src/db/project-exports';

type Call = { sql: string; values: unknown[] };

class ExportDb implements D1DatabaseLike {
  readonly calls: Call[] = [];
  readonly project = { id: 'p1', user_id: 'u1' };
  rows: ProjectExport[] = [];

  prepare(sql: string): D1StatementLike { return new ExportStatement(this, sql); }
}

class ExportStatement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private readonly db: ExportDb, private readonly sql: string) {}
  bind(...values: unknown[]): D1StatementLike { this.values = values; return this; }
  async run(): Promise<D1RunResultLike> {
    this.db.calls.push({ sql: this.sql, values: this.values });
    if (/INSERT INTO project_exports/i.test(this.sql)) {
      const [id, projectId, targetLanguage, output, batchId] = this.values as [string, string, ProjectExport['targetLanguage'], ProjectExport['output'], string | null];
      this.db.rows.push({ id, projectId, targetLanguage, output, batchId, status: 'pending', exportObjectKey: null, subtitleObjectKey: null, errorCode: null, errorMessage: null });
      return { meta: { changes: 1 } };
    }
    if (/UPDATE project_exports[\s\S]*status = 'invalidated'/i.test(this.sql)) {
      for (const row of this.db.rows) row.status = 'invalidated';
      return { meta: { changes: this.db.rows.length } };
    }
    return { meta: { changes: 1 } };
  }
  async first<T>(): Promise<T | null> {
    if (/SELECT id FROM projects/i.test(this.sql)) {
      const [projectId, userId] = this.values as [string, string];
      return projectId === this.db.project.id && userId === this.db.project.user_id ? ({ id: projectId } as T) : null;
    }
    if (/FROM project_exports e[\s\S]*ORDER BY e\.created_at DESC, e\.id DESC/i.test(this.sql)) {
      const [projectId, target, output, userId] = this.values as [string, string, string, string];
      const completedOnly = /e\.status\s*=\s*'completed'/i.test(this.sql);
      const row = [...this.db.rows].reverse().find((candidate) => candidate.projectId === projectId
        && candidate.targetLanguage === target
        && candidate.output === output
        && userId === this.db.project.user_id
        && (!completedOnly || candidate.status === 'completed'));
      if (!row) return null;
      return {
        id: row.id, project_id: row.projectId, target_language: row.targetLanguage, output: row.output,
        batch_id: row.batchId, status: row.status, export_object_key: row.exportObjectKey,
        subtitle_object_key: row.subtitleObjectKey, error_code: row.errorCode, error_message: row.errorMessage,
      } as T;
    }
    return null;
  }
  async all<T>(): Promise<{ results?: T[] }> {
    if (/FROM project_exports e[\s\S]*batch_id = \?/i.test(this.sql)) {
      const [projectId, batchId, userId] = this.values as [string, string, string];
      const rows = this.db.rows.filter((row) => row.projectId === projectId && row.batchId === batchId && userId === this.db.project.user_id)
        .map((row) => ({ id: row.id, project_id: row.projectId, target_language: row.targetLanguage, output: row.output, batch_id: row.batchId, status: row.status, export_object_key: row.exportObjectKey, subtitle_object_key: row.subtitleObjectKey, error_code: row.errorCode, error_message: row.errorMessage }));
      return { results: rows as T[] };
    }
    return { results: [] };
  }
}

describe('project export repository', () => {
  it('creates immutable target/output attempts and finds latest target variant', async () => {
    const db = new ExportDb();
    const repo = new ProjectExportRepository(db, () => 'export-1');
    const created = await repo.create('p1', 'u1', 'ja', 'dubbed', 'batch-7');
    expect(created).toMatchObject({ id: 'export-1', projectId: 'p1', targetLanguage: 'ja', output: 'dubbed', batchId: 'batch-7', status: 'pending' });
    expect(await repo.latest('p1', 'u1', 'ja', 'dubbed')).toMatchObject({ id: 'export-1', targetLanguage: 'ja', output: 'dubbed' });
  });

  it('finds the latest completed target attempt even when a newer attempt is not complete', async () => {
    const db = new ExportDb();
    db.rows.push(
      {
        id: 'export-completed', projectId: 'p1', targetLanguage: 'vi', output: 'dubbed', batchId: null,
        status: 'completed', exportObjectKey: 'projects/p1/exports/vi/export-completed.mp4', subtitleObjectKey: null,
        errorCode: null, errorMessage: null,
      },
      {
        id: 'export-pending', projectId: 'p1', targetLanguage: 'vi', output: 'dubbed', batchId: null,
        status: 'pending', exportObjectKey: null, subtitleObjectKey: null, errorCode: null, errorMessage: null,
      },
    );
    const repo = new ProjectExportRepository(db);

    expect(await repo.latest('p1', 'u1', 'vi', 'dubbed')).toMatchObject({ id: 'export-pending', status: 'pending' });
    expect(await repo.latestCompleted('p1', 'u1', 'vi', 'dubbed')).toMatchObject({
      id: 'export-completed',
      status: 'completed',
      exportObjectKey: 'projects/p1/exports/vi/export-completed.mp4',
    });
  });

  it('lists a batch without collapsing per-language attempts', async () => {
    const db = new ExportDb();
    let id = 0;
    const repo = new ProjectExportRepository(db, () => `export-${++id}`);
    await repo.create('p1', 'u1', 'ja', 'dubbed', 'batch-1');
    await repo.create('p1', 'u1', 'ko', 'dubbed', 'batch-1');
    expect((await repo.listBatch('p1', 'u1', 'batch-1')).map((entry) => entry.targetLanguage)).toEqual(['ja', 'ko']);
  });
});
