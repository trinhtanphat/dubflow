import { describe, expect, it } from 'vitest';
import {
  ProjectRepository,
  type D1DatabaseLike,
  type D1RunResultLike,
  type D1StatementLike,
} from '../src/db/projects';

type TargetLanguageRow = {
  targetLanguage: string;
  status: string;
};

class CreateProjectMemoryDb implements D1DatabaseLike {
  readonly targetLanguages = new Map<string, TargetLanguageRow>();

  prepare(sql: string): D1StatementLike {
    return new CreateProjectStatement(this, sql);
  }
}

class CreateProjectStatement implements D1StatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: CreateProjectMemoryDb,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    this.values = values;
    return this;
  }

  async run(): Promise<D1RunResultLike> {
    if (/INSERT OR IGNORE INTO users/i.test(this.sql)) {
      return { meta: { changes: 1 } };
    }
    if (/INSERT INTO projects/i.test(this.sql)) {
      return { meta: { changes: 1 } };
    }
    if (/INSERT INTO project_target_languages/i.test(this.sql)) {
      const [projectId, targetLanguage] = this.values as [string, string];
      this.db.targetLanguages.set(projectId, {
        targetLanguage,
        status: 'pending',
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: [] };
  }

  async first<T>(): Promise<T | null> {
    return null;
  }
}

describe('project creation language seed', () => {
  it('persists Vietnamese as the enabled default target for a new project', async () => {
    const db = new CreateProjectMemoryDb();
    const repository = new ProjectRepository(db);

    const project = await repository.create('dev-user', {
      title: 'Production E2E fixture',
      sourceLanguage: 'auto',
      targetLanguage: 'vi',
    });

    expect(db.targetLanguages.get(project.id)).toEqual({
      targetLanguage: 'vi',
      status: 'pending',
    });
  });
});
