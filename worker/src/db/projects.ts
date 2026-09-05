import type { CreateProjectInput } from '../domain/project';

export type Project = {
  id: string;
  userId: string;
  title: string;
  sourceLanguage: CreateProjectInput['sourceLanguage'];
  targetLanguage: 'vi';
  status: string;
  sourceObjectKey?: string | null;
  sizeBytes?: number | null;
};

export interface ProjectStore {
  create(userId: string, input: CreateProjectInput): Promise<Project>;
  listByUser(userId: string): Promise<Project[]>;
  getByIdForUser(id: string, userId: string): Promise<Project | null>;
  setSourceObject(id: string, userId: string, objectKey: string, sizeBytes: number): Promise<void>;
}

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
}

type ProjectRow = {
  id: string;
  user_id: string;
  title: string;
  source_language: CreateProjectInput['sourceLanguage'];
  target_language: 'vi';
  status: string;
  source_object_key?: string | null;
  size_bytes?: number | null;
};

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    status: row.status,
    sourceObjectKey: row.source_object_key,
    sizeBytes: row.size_bytes,
  };
}

export class ProjectRepository implements ProjectStore {
  constructor(private readonly db: D1DatabaseLike) {}

  private async ensureDevelopmentUser(userId: string) {
    await this.db.prepare(
      `INSERT OR IGNORE INTO users (id, display_name, plan, credit_balance) VALUES (?, ?, 'free', 50000)`,
    ).bind(userId, 'DubFlow Developer').run();
  }

  async create(userId: string, input: CreateProjectInput): Promise<Project> {
    await this.ensureDevelopmentUser(userId);
    const id = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO projects (id, user_id, title, source_language, target_language, status)
       VALUES (?, ?, ?, ?, ?, 'draft')`,
    ).bind(id, userId, input.title, input.sourceLanguage, input.targetLanguage).run();

    return {
      id,
      userId,
      title: input.title,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      status: 'draft',
    };
  }

  async listByUser(userId: string): Promise<Project[]> {
    const result = await this.db.prepare(
      `SELECT id, user_id, title, source_language, target_language, status, source_object_key, size_bytes
       FROM projects WHERE user_id = ? ORDER BY updated_at DESC`,
    ).bind(userId).all<ProjectRow>();
    return (result.results ?? []).map(fromRow);
  }

  async getByIdForUser(id: string, userId: string): Promise<Project | null> {
    const row = await this.db.prepare(
      `SELECT id, user_id, title, source_language, target_language, status, source_object_key, size_bytes
       FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(id, userId).first<ProjectRow>();
    return row ? fromRow(row) : null;
  }

  async setSourceObject(id: string, userId: string, objectKey: string, sizeBytes: number): Promise<void> {
    await this.db.prepare(
      `UPDATE projects
       SET source_object_key = ?, size_bytes = ?, status = 'ready', updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    ).bind(objectKey, sizeBytes, id, userId).run();
  }
}
