import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import {
  ProjectLanguagePersistenceError,
  ProjectLanguageRepository,
} from '../src/db/project-languages';
import type { ProjectLanguageStatus, TargetLanguage } from '../src/domain/language';

type LanguageRow = { target_language: TargetLanguage; status: ProjectLanguageStatus };

class LanguageMemoryDb implements D1DatabaseLike {
  revision = 1;
  readonly project = { id: 'p1', user_id: 'u1' };
  readonly rows = new Map<TargetLanguage, ProjectLanguageStatus>([['vi', 'pending']]);

  prepare(sql: string): D1StatementLike { return new LanguageStatement(this, sql); }

  async batch(statements: D1StatementLike[]) {
    const results: D1RunResultLike[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class LanguageStatement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private readonly db: LanguageMemoryDb, private readonly sql: string) {}
  bind(...values: unknown[]): D1StatementLike { this.values = values; return this; }

  async run(): Promise<D1RunResultLike> {
    if (/UPDATE projects[\s\S]*target_languages_revision = target_languages_revision \+ 1/i.test(this.sql)) {
      const [projectId, userId, expectedRevision] = this.values as [string, string, number];
      if (projectId !== this.db.project.id || userId !== this.db.project.user_id || expectedRevision !== this.db.revision) {
        return { meta: { changes: 0 } };
      }
      this.db.revision += 1;
      return { meta: { changes: 1 } };
    }
    if (/DELETE FROM project_target_languages/i.test(this.sql)) {
      const [projectId, ...targets] = this.values as [string, ...TargetLanguage[]];
      if (projectId !== this.db.project.id) return { meta: { changes: 0 } };
      const keep = new Set(targets);
      for (const target of [...this.db.rows.keys()]) if (!keep.has(target)) this.db.rows.delete(target);
      return { meta: { changes: 1 } };
    }
    if (/INSERT INTO project_target_languages/i.test(this.sql)) {
      const [projectId, target] = this.values as [string, TargetLanguage];
      if (projectId !== this.db.project.id) return { meta: { changes: 0 } };
      if (!this.db.rows.has(target)) this.db.rows.set(target, 'pending');
      return { meta: { changes: 1 } };
    }
    if (/UPDATE project_target_languages[\s\S]*SET status/i.test(this.sql)) {
      const [status, projectId, target, ownerProjectId, userId] = this.values as [ProjectLanguageStatus, string, TargetLanguage, string, string];
      if (projectId !== this.db.project.id || ownerProjectId !== projectId || userId !== this.db.project.user_id || !this.db.rows.has(target)) {
        return { meta: { changes: 0 } };
      }
      this.db.rows.set(target, status);
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  async first<T>(): Promise<T | null> {
    if (/SELECT[\s\S]*target_languages_revision[\s\S]*FROM projects/i.test(this.sql)) {
      const [projectId, userId] = this.values as [string, string];
      if (projectId !== this.db.project.id || userId !== this.db.project.user_id) return null;
      return { target_languages_revision: this.db.revision } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results?: T[] }> {
    if (/FROM project_target_languages/i.test(this.sql)) {
      const [projectId] = this.values as [string];
      if (projectId !== this.db.project.id) return { results: [] };
      const rows: LanguageRow[] = [...this.db.rows.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target_language, status]) => ({ target_language, status }));
      return { results: rows as T[] };
    }
    return { results: [] };
  }
}

describe('project language repository', () => {
  it('returns the Vietnamese compatibility target by default', async () => {
    const repo = new ProjectLanguageRepository(new LanguageMemoryDb());
    expect(await repo.getConfig('p1', 'u1')).toEqual({
      revision: 1,
      languages: [{ targetLanguage: 'vi', status: 'pending' }],
    });
  });

  it('uses exact revision CAS and rejects duplicate/empty targets', async () => {
    const db = new LanguageMemoryDb();
    const repo = new ProjectLanguageRepository(db);
    const updated = await repo.updateEnabled('p1', 'u1', 1, ['vi', 'ja']);
    expect(updated.revision).toBe(2);
    expect(updated.languages.map((entry) => entry.targetLanguage).sort()).toEqual(['ja', 'vi']);

    await expect(repo.updateEnabled('p1', 'u1', 2, [])).rejects.toMatchObject({ code: 'PROJECT_LANGUAGES_INVALID' });
    await expect(repo.updateEnabled('p1', 'u1', 2, ['ja', 'ja'])).rejects.toMatchObject({ code: 'PROJECT_LANGUAGES_INVALID' });
  });

  it('returns canonical config on a stale revision conflict', async () => {
    const db = new LanguageMemoryDb();
    const repo = new ProjectLanguageRepository(db);
    await repo.updateEnabled('p1', 'u1', 1, ['vi', 'ja']);

    try {
      await repo.updateEnabled('p1', 'u1', 1, ['vi', 'en']);
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectLanguagePersistenceError);
      expect(error).toMatchObject({ code: 'PROJECT_LANGUAGES_CONFLICT', canonical: { revision: 2 } });
    }
  });
});
