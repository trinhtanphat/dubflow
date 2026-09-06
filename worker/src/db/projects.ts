import type { CreateProjectInput } from '../domain/project';

export type ProjectStatus =
  | 'draft'
  | 'uploading'
  | 'ready'
  | 'processing'
  | 'needs_review'
  | 'failed'
  | 'completed'
  | 'cancelled';

export type Project = {
  id: string;
  userId: string;
  title: string;
  sourceLanguage: CreateProjectInput['sourceLanguage'];
  targetLanguage: 'vi';
  targetLanguagesRevision: number;
  sourceRevision: number;
  status: ProjectStatus;
  sourceObjectKey?: string | null;
  exportObjectKey?: string | null;
  durationMs?: number | null;
  sizeBytes?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export interface ProjectStore {
  create(userId: string, input: CreateProjectInput): Promise<Project>;
  listByUser(userId: string): Promise<Project[]>;
  getByIdForUser(id: string, userId: string): Promise<Project | null>;
  setSourceObject(id: string, userId: string, objectKey: string, sizeBytes: number): Promise<void>;
  setExportObject(id: string, userId: string, objectKey: string): Promise<void>;
  setStatus(id: string, userId: string, status: ProjectStatus, durationMs?: number): Promise<void>;
}

export type D1RunResultLike = {
  meta?: { changes?: number };
  changes?: number;
};

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<D1RunResultLike>;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
  batch?(statements: D1StatementLike[]): Promise<unknown[]>;
}

type ProjectRow = {
  id: string;
  user_id: string;
  title: string;
  source_language: CreateProjectInput['sourceLanguage'];
  target_language: 'vi';
  target_languages_revision: number;
  source_revision: number;
  status: ProjectStatus;
  source_object_key?: string | null;
  export_object_key?: string | null;
  duration_ms?: number | null;
  size_bytes?: number | null;
  created_at?: string;
  updated_at?: string;
};

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    targetLanguagesRevision: row.target_languages_revision,
    sourceRevision: row.source_revision,
    status: row.status,
    sourceObjectKey: row.source_object_key,
    exportObjectKey: row.export_object_key,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROJECT_COLUMNS = `id, user_id, title, source_language, target_language, target_languages_revision, source_revision, status, source_object_key, export_object_key, duration_ms, size_bytes, created_at, updated_at`;

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
      targetLanguagesRevision: 1,
      sourceRevision: 1,
      status: 'draft',
    };
  }

  async listByUser(userId: string): Promise<Project[]> {
    const result = await this.db.prepare(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE user_id = ? ORDER BY updated_at DESC`,
    ).bind(userId).all<ProjectRow>();
    return (result.results ?? []).map(fromRow);
  }

  async getByIdForUser(id: string, userId: string): Promise<Project | null> {
    const row = await this.db.prepare(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(id, userId).first<ProjectRow>();
    return row ? fromRow(row) : null;
  }

  async setSourceObject(id: string, userId: string, objectKey: string, sizeBytes: number): Promise<void> {
    await this.db.prepare(
      `UPDATE projects
       SET source_revision = source_revision + 1 - CASE
             WHEN source_object_key IS NULL OR source_object_key = ? THEN 1 ELSE 0 END,
           source_object_key = ?, size_bytes = ?, status = 'ready', updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    ).bind(objectKey, objectKey, sizeBytes, id, userId).run();
  }

  async setExportObject(id: string, userId: string, objectKey: string): Promise<void> {
    const prefix = `projects/${id}/export/`;
    if (!objectKey.startsWith(prefix)) {
      throw new Error('Export object key must belong to the project export prefix.');
    }
    await this.db.prepare(
      `UPDATE projects SET export_object_key = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
    ).bind(objectKey, id, userId).run();
  }

  async setStatus(id: string, userId: string, status: ProjectStatus, durationMs?: number): Promise<void> {
    if (durationMs === undefined) {
      await this.db.prepare(
        `UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
      ).bind(status, id, userId).run();
      return;
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('Project duration must be a non-negative finite number.');
    }
    await this.db.prepare(
      `UPDATE projects SET status = ?, duration_ms = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
    ).bind(status, Math.round(durationMs), id, userId).run();
  }
}
