import type { D1DatabaseLike } from './projects';
import type { ExportOutput, TargetLanguage } from '../domain/language';

export type ProjectExportStatus = 'pending' | 'exporting' | 'completed' | 'failed' | 'invalidated';

export type ProjectExport = {
  id: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  batchId: string | null;
  status: ProjectExportStatus;
  exportObjectKey: string | null;
  subtitleObjectKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

type ProjectExportRow = {
  id: string;
  project_id: string;
  target_language: TargetLanguage;
  output: ExportOutput;
  batch_id: string | null;
  status: ProjectExportStatus;
  export_object_key: string | null;
  subtitle_object_key: string | null;
  error_code: string | null;
  error_message: string | null;
};

function fromRow(row: ProjectExportRow): ProjectExport {
  return {
    id: row.id,
    projectId: row.project_id,
    targetLanguage: row.target_language,
    output: row.output,
    batchId: row.batch_id,
    status: row.status,
    exportObjectKey: row.export_object_key,
    subtitleObjectKey: row.subtitle_object_key,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export class ProjectExportPersistenceError extends Error {
  constructor(public readonly code: 'PROJECT_NOT_FOUND' | 'EXPORT_NOT_FOUND', message: string) {
    super(message);
    this.name = 'ProjectExportPersistenceError';
  }
}

export class ProjectExportRepository {
  constructor(
    private readonly db: D1DatabaseLike,
    private readonly makeId: () => string = () => crypto.randomUUID(),
  ) {}

  private async assertProject(projectId: string, userId: string): Promise<void> {
    const project = await this.db.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<{ id: string }>();
    if (!project) throw new ProjectExportPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
  }

  async create(
    projectId: string,
    userId: string,
    targetLanguage: TargetLanguage,
    output: ExportOutput,
    batchId: string | null = null,
  ): Promise<ProjectExport> {
    await this.assertProject(projectId, userId);
    const id = this.makeId();
    await this.db.prepare(
      `INSERT INTO project_exports (id, project_id, target_language, output, batch_id, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).bind(id, projectId, targetLanguage, output, batchId).run();
    return {
      id,
      projectId,
      targetLanguage,
      output,
      batchId,
      status: 'pending',
      exportObjectKey: null,
      subtitleObjectKey: null,
      errorCode: null,
      errorMessage: null,
    };
  }

  async latest(
    projectId: string,
    userId: string,
    targetLanguage: TargetLanguage,
    output: ExportOutput,
  ): Promise<ProjectExport | null> {
    const row = await this.db.prepare(
      `SELECT e.id, e.project_id, e.target_language, e.output, e.batch_id, e.status,
              e.export_object_key, e.subtitle_object_key, e.error_code, e.error_message
       FROM project_exports e
       JOIN projects p ON p.id = e.project_id
       WHERE e.project_id = ? AND e.target_language = ? AND e.output = ? AND p.user_id = ?
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 1`,
    ).bind(projectId, targetLanguage, output, userId).first<ProjectExportRow>();
    return row ? fromRow(row) : null;
  }

  async latestCompleted(
    projectId: string,
    userId: string,
    targetLanguage: TargetLanguage,
    output: ExportOutput,
  ): Promise<ProjectExport | null> {
    const row = await this.db.prepare(
      `SELECT e.id, e.project_id, e.target_language, e.output, e.batch_id, e.status,
              e.export_object_key, e.subtitle_object_key, e.error_code, e.error_message
       FROM project_exports e
       JOIN projects p ON p.id = e.project_id
       WHERE e.project_id = ? AND e.target_language = ? AND e.output = ?
         AND e.status = 'completed' AND p.user_id = ?
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 1`,
    ).bind(projectId, targetLanguage, output, userId).first<ProjectExportRow>();
    return row ? fromRow(row) : null;
  }

  async listBatch(projectId: string, userId: string, batchId: string): Promise<ProjectExport[]> {
    const result = await this.db.prepare(
      `SELECT e.id, e.project_id, e.target_language, e.output, e.batch_id, e.status,
              e.export_object_key, e.subtitle_object_key, e.error_code, e.error_message
       FROM project_exports e
       JOIN projects p ON p.id = e.project_id
       WHERE e.project_id = ? AND e.batch_id = ? AND p.user_id = ?
       ORDER BY e.created_at ASC, e.id ASC`,
    ).bind(projectId, batchId, userId).all<ProjectExportRow>();
    return (result.results ?? []).map(fromRow);
  }

  async complete(
    projectId: string,
    exportId: string,
    userId: string,
    keys: { exportObjectKey?: string | null; subtitleObjectKey?: string | null },
  ): Promise<void> {
    await this.assertProject(projectId, userId);
    await this.db.prepare(
      `UPDATE project_exports
       SET status = 'completed', export_object_key = ?, subtitle_object_key = ?,
           error_code = NULL, error_message = NULL, updated_at = datetime('now')
       WHERE id = ? AND project_id = ?`,
    ).bind(keys.exportObjectKey ?? null, keys.subtitleObjectKey ?? null, exportId, projectId).run();
  }

  async fail(projectId: string, exportId: string, userId: string, code: string, message: string): Promise<void> {
    await this.assertProject(projectId, userId);
    await this.db.prepare(
      `UPDATE project_exports
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = datetime('now')
       WHERE id = ? AND project_id = ?`,
    ).bind(code, message, exportId, projectId).run();
  }

  async invalidateTarget(projectId: string, userId: string, targetLanguage: TargetLanguage): Promise<void> {
    await this.assertProject(projectId, userId);
    await this.db.prepare(
      `UPDATE project_exports
       SET status = 'invalidated', updated_at = datetime('now')
       WHERE project_id = ? AND target_language = ? AND status IN ('pending','exporting','completed','failed')`,
    ).bind(projectId, targetLanguage).run();
  }

  async invalidateAll(projectId: string, userId: string): Promise<void> {
    await this.assertProject(projectId, userId);
    await this.db.prepare(
      `UPDATE project_exports
       SET status = 'invalidated', updated_at = datetime('now')
       WHERE project_id = ? AND status IN ('pending','exporting','completed','failed')`,
    ).bind(projectId).run();
  }
}
