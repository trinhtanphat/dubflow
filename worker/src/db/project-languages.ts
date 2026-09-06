import type { D1DatabaseLike } from './projects';
import {
  isTargetLanguage,
  type ProjectLanguageStatus,
  type TargetLanguage,
} from '../domain/language';

export type ProjectLanguageConfig = {
  revision: number;
  languages: { targetLanguage: TargetLanguage; status: ProjectLanguageStatus }[];
};

type RevisionRow = { target_languages_revision: number };
type LanguageRow = { target_language: TargetLanguage; status: ProjectLanguageStatus };

function changes(result: { meta?: { changes?: number }; changes?: number }): number {
  return result.meta?.changes ?? result.changes ?? 0;
}

export class ProjectLanguagePersistenceError extends Error {
  constructor(
    public readonly code: 'PROJECT_LANGUAGES_INVALID' | 'PROJECT_LANGUAGES_CONFLICT' | 'PROJECT_NOT_FOUND' | 'PROJECT_LANGUAGE_NOT_FOUND',
    message: string,
    public readonly canonical?: ProjectLanguageConfig,
  ) {
    super(message);
    this.name = 'ProjectLanguagePersistenceError';
  }
}

export interface ProjectLanguageStore {
  getConfig(projectId: string, userId: string): Promise<ProjectLanguageConfig | null>;
  updateEnabled(projectId: string, userId: string, expectedRevision: number, targets: TargetLanguage[]): Promise<ProjectLanguageConfig>;
  setStatus(projectId: string, userId: string, target: TargetLanguage, status: ProjectLanguageStatus): Promise<void>;
}

export class ProjectLanguageRepository implements ProjectLanguageStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getConfig(projectId: string, userId: string): Promise<ProjectLanguageConfig | null> {
    const revision = await this.db.prepare(
      `SELECT target_languages_revision FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<RevisionRow>();
    if (!revision) return null;

    const result = await this.db.prepare(
      `SELECT target_language, status
       FROM project_target_languages
       WHERE project_id = ?
       ORDER BY target_language ASC`,
    ).bind(projectId).all<LanguageRow>();

    return {
      revision: revision.target_languages_revision,
      languages: (result.results ?? []).map((row) => ({
        targetLanguage: row.target_language,
        status: row.status,
      })),
    };
  }

  async updateEnabled(
    projectId: string,
    userId: string,
    expectedRevision: number,
    targets: TargetLanguage[],
  ): Promise<ProjectLanguageConfig> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new ProjectLanguagePersistenceError('PROJECT_LANGUAGES_INVALID', 'Expected language revision must be a positive integer.');
    }
    if (targets.length === 0 || targets.some((target) => !isTargetLanguage(target)) || new Set(targets).size !== targets.length) {
      throw new ProjectLanguagePersistenceError('PROJECT_LANGUAGES_INVALID', 'At least one unique supported target language is required.');
    }

    const cas = await this.db.prepare(
      `UPDATE projects
       SET target_languages_revision = target_languages_revision + 1,
           updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND target_languages_revision = ?`,
    ).bind(projectId, userId, expectedRevision).run();

    if (changes(cas) !== 1) {
      const canonical = await this.getConfig(projectId, userId);
      if (!canonical) throw new ProjectLanguagePersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
      throw new ProjectLanguagePersistenceError('PROJECT_LANGUAGES_CONFLICT', 'Project language configuration changed on the server.', canonical);
    }

    const sorted = [...targets].sort();
    const placeholders = sorted.map(() => '?').join(', ');
    const statements = [
      this.db.prepare(
        `DELETE FROM project_target_languages
         WHERE project_id = ? AND target_language NOT IN (${placeholders})`,
      ).bind(projectId, ...sorted),
      ...sorted.map((target) => this.db.prepare(
        `INSERT INTO project_target_languages (project_id, target_language, status)
         VALUES (?, ?, 'pending')
         ON CONFLICT(project_id, target_language) DO NOTHING`,
      ).bind(projectId, target)),
    ];

    if (this.db.batch) await this.db.batch(statements);
    else for (const statement of statements) await statement.run();

    const updated = await this.getConfig(projectId, userId);
    if (!updated) throw new ProjectLanguagePersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    return updated;
  }

  async setStatus(
    projectId: string,
    userId: string,
    target: TargetLanguage,
    status: ProjectLanguageStatus,
  ): Promise<void> {
    const result = await this.db.prepare(
      `UPDATE project_target_languages
       SET status = ?, updated_at = datetime('now')
       WHERE project_id = ? AND target_language = ?
         AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND user_id = ?)`,
    ).bind(status, projectId, target, projectId, userId).run();
    if (changes(result) === 0) {
      const config = await this.getConfig(projectId, userId);
      if (!config) throw new ProjectLanguagePersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
      throw new ProjectLanguagePersistenceError('PROJECT_LANGUAGE_NOT_FOUND', 'Target language is not enabled for this project.', config);
    }
  }
}
