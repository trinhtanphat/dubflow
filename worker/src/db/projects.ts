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
  sourceGeneration: number;
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
  source_generation?: number;
  status: ProjectStatus;
  source_object_key?: string | null;
  export_object_key?: string | null;
  duration_ms?: number | null;
  size_bytes?: number | null;
  created_at?: string;
  updated_at?: string;
};

type TableInfoRow = { name: string };

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    targetLanguagesRevision: Number(row.target_languages_revision ?? 1),
    sourceGeneration: Number(row.source_generation ?? 1),
    status: row.status,
    sourceObjectKey: row.source_object_key,
    exportObjectKey: row.export_object_key ?? null,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CURRENT_PROJECT_COLUMNS = `id, user_id, title, source_language, target_language, target_languages_revision, source_generation, status, source_object_key, export_object_key, duration_ms, size_bytes, created_at, updated_at`;

export class ProjectRepository implements ProjectStore {
  private projectColumnsPromise?: Promise<Set<string>>;

  constructor(private readonly db: D1DatabaseLike) {}

  private async projectColumns(): Promise<Set<string>> {
    if (!this.projectColumnsPromise) {
      this.projectColumnsPromise = this.db
        .prepare("PRAGMA table_info('projects')")
        .all<TableInfoRow>()
        .then((result) => new Set((result.results ?? []).map((row) => row.name)));
    }
    return this.projectColumnsPromise;
  }

  private async readableProjectColumns(): Promise<string> {
    const columns = await this.projectColumns();
    if (columns.size === 0) return CURRENT_PROJECT_COLUMNS;

    const targetLanguagesRevision = columns.has('target_languages_revision')
      ? 'target_languages_revision'
      : '1 AS target_languages_revision';
    const sourceGeneration = columns.has('source_generation')
      ? 'source_generation'
      : '1 AS source_generation';
    const exportObjectKey = columns.has('export_object_key')
      ? 'export_object_key'
      : 'NULL AS export_object_key';

    return `id, user_id, title, source_language, target_language, ${targetLanguagesRevision}, ${sourceGeneration}, status, source_object_key, ${exportObjectKey}, duration_ms, size_bytes, created_at, updated_at`;
  }

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
      sourceGeneration: 1,
      status: 'draft',
    };
  }

  async listByUser(userId: string): Promise<Project[]> {
    const columns = await this.readableProjectColumns();
    const result = await this.db.prepare(
      `SELECT ${columns} FROM projects WHERE user_id = ? ORDER BY updated_at DESC`,
    ).bind(userId).all<ProjectRow>();
    return (result.results ?? []).map(fromRow);
  }

  async getByIdForUser(id: string, userId: string): Promise<Project | null> {
    const columns = await this.readableProjectColumns();
    const row = await this.db.prepare(
      `SELECT ${columns} FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(id, userId).first<ProjectRow>();
    return row ? fromRow(row) : null;
  }

  async setSourceObject(id: string, userId: string, objectKey: string, sizeBytes: number): Promise<void> {
    await this.db.prepare(
      `UPDATE projects
       SET source_generation = CASE
             WHEN source_object_key IS NULL OR source_object_key = ? THEN source_generation
             ELSE source_generation + 1
           END,
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
