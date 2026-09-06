import type { D1DatabaseLike } from './projects';
import { parseProjectTargetLanguages, type TargetLanguage } from '../domain/target-language';

export type TargetTranslation = {
  segmentId: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  translatedText: string;
  translationEngine: string;
  translationStatus: string;
  contextRevision: number | null;
  sourceSegmentVersion: number;
  version: number;
};

export type TargetDub = {
  segmentId: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  status: string;
  objectKey: string | null;
  voiceProvider: string | null;
  voiceId: string | null;
  translationVersion: number;
  segmentVersion: number;
  durationMs: number | null;
};

export type ExportVariant = {
  id: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  status: 'queued' | 'running' | 'failed' | 'completed' | 'cancelled';
  objectKey: string | null;
  jobId: string | null;
  errorCode: string | null;
  generation: number;
};

export interface MultilangStore {
  listTargets(projectId: string, userId: string): Promise<TargetLanguage[]>;
  replaceTargets(projectId: string, userId: string, targets: TargetLanguage[]): Promise<TargetLanguage[]>;
  getTranslation(projectId: string, segmentId: string, userId: string, targetLanguage: TargetLanguage): Promise<TargetTranslation | null>;
  upsertTranslation(input: TargetTranslation & { userId: string }): Promise<TargetTranslation>;
  getDub(projectId: string, segmentId: string, userId: string, targetLanguage: TargetLanguage): Promise<TargetDub | null>;
  upsertDub(input: TargetDub & { userId: string }): Promise<TargetDub>;
  invalidateSegmentAllTargets(projectId: string, segmentId: string, userId: string): Promise<void>;
  invalidateSegmentTarget(projectId: string, segmentId: string, userId: string, targetLanguage: TargetLanguage): Promise<void>;
  invalidateSpeakerAllTargets(projectId: string, speakerId: string, userId: string): Promise<void>;
  createExport(input: { id: string; projectId: string; userId: string; targetLanguage: TargetLanguage; jobId: string; generation: number }): Promise<ExportVariant>;
  getExport(projectId: string, exportId: string, userId: string): Promise<ExportVariant | null>;
  listExports(projectId: string, userId: string): Promise<ExportVariant[]>;
  setExportRunning(projectId: string, exportId: string, userId: string): Promise<void>;
  completeExport(projectId: string, exportId: string, userId: string, objectKey: string): Promise<void>;
  failExport(projectId: string, exportId: string, userId: string, errorCode: string): Promise<void>;
  invalidateExportsForTarget(projectId: string, userId: string, targetLanguage: TargetLanguage): Promise<void>;
}

type TranslationRow = {
  segment_id: string; project_id: string; target_language: TargetLanguage; translated_text: string;
  translation_engine: string; translation_status: string; context_revision: number | null;
  source_segment_version: number; version: number;
};
type DubRow = {
  segment_id: string; project_id: string; target_language: TargetLanguage; status: string; object_key: string | null;
  voice_provider: string | null; voice_id: string | null; translation_version: number; segment_version: number; duration_ms: number | null;
};
type ExportRow = {
  id: string; project_id: string; target_language: TargetLanguage; status: ExportVariant['status']; object_key: string | null;
  job_id: string | null; error_code: string | null; generation: number;
};

const translationFromRow = (row: TranslationRow): TargetTranslation => ({
  segmentId: row.segment_id, projectId: row.project_id, targetLanguage: row.target_language,
  translatedText: row.translated_text, translationEngine: row.translation_engine, translationStatus: row.translation_status,
  contextRevision: row.context_revision, sourceSegmentVersion: row.source_segment_version, version: row.version,
});
const dubFromRow = (row: DubRow): TargetDub => ({
  segmentId: row.segment_id, projectId: row.project_id, targetLanguage: row.target_language, status: row.status,
  objectKey: row.object_key, voiceProvider: row.voice_provider, voiceId: row.voice_id,
  translationVersion: row.translation_version, segmentVersion: row.segment_version, durationMs: row.duration_ms,
});
const exportFromRow = (row: ExportRow): ExportVariant => ({
  id: row.id, projectId: row.project_id, targetLanguage: row.target_language, status: row.status,
  objectKey: row.object_key, jobId: row.job_id, errorCode: row.error_code, generation: row.generation,
});

export class MultilangRepository implements MultilangStore {
  constructor(private readonly db: D1DatabaseLike) {}

  private async ownsProject(projectId: string, userId: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1').bind(projectId, userId).first<{ id: string }>();
    return Boolean(row);
  }

  async listTargets(projectId: string, userId: string): Promise<TargetLanguage[]> {
    if (!(await this.ownsProject(projectId, userId))) return [];
    const result = await this.db.prepare(
      'SELECT target_language FROM project_targets WHERE project_id = ? AND enabled = 1 ORDER BY created_at, target_language',
    ).bind(projectId).all<{ target_language: TargetLanguage }>();
    const targets = (result.results ?? []).map((row) => row.target_language);
    return targets.includes('vi') ? targets : ['vi', ...targets];
  }

  async replaceTargets(projectId: string, userId: string, targets: TargetLanguage[]): Promise<TargetLanguage[]> {
    if (!(await this.ownsProject(projectId, userId))) return [];
    const normalized = parseProjectTargetLanguages(targets);
    const effective = normalized.includes('vi') ? normalized : ['vi', ...normalized];
    const statements = [
      this.db.prepare('DELETE FROM project_targets WHERE project_id = ?').bind(projectId),
      ...effective.map((target) => this.db.prepare(
        `INSERT INTO project_targets (project_id, target_language, enabled) VALUES (?, ?, 1)`,
      ).bind(projectId, target)),
    ];
    if (this.db.batch) await this.db.batch(statements);
    else for (const statement of statements) await statement.run();
    return effective;
  }

  async getTranslation(projectId: string, segmentId: string, userId: string, targetLanguage: TargetLanguage): Promise<TargetTranslation | null> {
    if (!(await this.ownsProject(projectId, userId))) return null;
    const row = await this.db.prepare(
      `SELECT segment_id, project_id, target_language, translated_text, translation_engine, translation_status,
              context_revision, source_segment_version, version
       FROM segment_translations WHERE project_id = ? AND segment_id = ? AND target_language = ? LIMIT 1`,
    ).bind(projectId, segmentId, targetLanguage).first<TranslationRow>();
    return row ? translationFromRow(row) : null;
  }

  async upsertTranslation(input: TargetTranslation & { userId: string }): Promise<TargetTranslation> {
    if (!(await this.ownsProject(input.projectId, input.userId))) throw new Error('Project not found.');
    await this.db.prepare(
      `INSERT INTO segment_translations
       (segment_id, project_id, target_language, translated_text, translation_engine, translation_status, context_revision, source_segment_version, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(segment_id, target_language) DO UPDATE SET
         translated_text=excluded.translated_text, translation_engine=excluded.translation_engine,
         translation_status=excluded.translation_status, context_revision=excluded.context_revision,
         source_segment_version=excluded.source_segment_version, version=excluded.version, updated_at=datetime('now')`,
    ).bind(input.segmentId, input.projectId, input.targetLanguage, input.translatedText, input.translationEngine,
      input.translationStatus, input.contextRevision, input.sourceSegmentVersion, input.version).run();
    return { ...input };
  }

  async getDub(projectId: string, segmentId: string, userId: string, targetLanguage: TargetLanguage): Promise<TargetDub | null> {
    if (!(await this.ownsProject(projectId, userId))) return null;
    const row = await this.db.prepare(
      `SELECT segment_id, project_id, target_language, status, object_key, voice_provider, voice_id,
              translation_version, segment_version, duration_ms
       FROM segment_dubs WHERE project_id = ? AND segment_id = ? AND target_language = ? LIMIT 1`,
    ).bind(projectId, segmentId, targetLanguage).first<DubRow>();
    return row ? dubFromRow(row) : null;
  }

  async upsertDub(input: TargetDub & { userId: string }): Promise<TargetDub> {
    if (!(await this.ownsProject(input.projectId, input.userId))) throw new Error('Project not found.');
    if (input.objectKey && !input.objectKey.startsWith(`projects/${input.projectId}/dubbed/${input.targetLanguage}/`)) {
      throw new Error('Dub object key is outside the target prefix.');
    }
    await this.db.prepare(
      `INSERT INTO segment_dubs
       (segment_id, project_id, target_language, status, object_key, voice_provider, voice_id, translation_version, segment_version, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(segment_id, target_language) DO UPDATE SET
         status=excluded.status, object_key=excluded.object_key, voice_provider=excluded.voice_provider, voice_id=excluded.voice_id,
         translation_version=excluded.translation_version, segment_version=excluded.segment_version, duration_ms=excluded.duration_ms,
         updated_at=datetime('now')`,
    ).bind(input.segmentId, input.projectId, input.targetLanguage, input.status, input.objectKey, input.voiceProvider,
      input.voiceId, input.translationVersion, input.segmentVersion, input.durationMs).run();
    return { ...input };
  }

  async invalidateSegmentAllTargets(projectId: string, segmentId: string, userId: string): Promise<void> {
    if (!(await this.ownsProject(projectId, userId))) return;
    await this.db.prepare("UPDATE segment_translations SET translation_status='stale', updated_at=datetime('now') WHERE project_id=? AND segment_id=?")
      .bind(projectId, segmentId).run();
    await this.db.prepare("UPDATE segment_dubs SET status='stale', object_key=NULL, updated_at=datetime('now') WHERE project_id=? AND segment_id=?")
      .bind(projectId, segmentId).run();
    await this.db.prepare("UPDATE project_exports SET status='cancelled', object_key=NULL, updated_at=datetime('now') WHERE project_id=? AND status IN ('queued','running','completed')")
      .bind(projectId).run();
  }

  async invalidateSegmentTarget(projectId: string, segmentId: string, userId: string, targetLanguage: TargetLanguage): Promise<void> {
    if (!(await this.ownsProject(projectId, userId))) return;
    await this.db.prepare("UPDATE segment_dubs SET status='stale', object_key=NULL, updated_at=datetime('now') WHERE project_id=? AND segment_id=? AND target_language=?")
      .bind(projectId, segmentId, targetLanguage).run();
    await this.invalidateExportsForTarget(projectId, userId, targetLanguage);
  }

  async invalidateSpeakerAllTargets(projectId: string, speakerId: string, userId: string): Promise<void> {
    if (!(await this.ownsProject(projectId, userId))) return;
    await this.db.prepare(
      `UPDATE segment_dubs SET status='stale', object_key=NULL, updated_at=datetime('now')
       WHERE project_id=? AND segment_id IN (SELECT id FROM segments WHERE project_id=? AND speaker_id=?)`,
    ).bind(projectId, projectId, speakerId).run();
    await this.db.prepare("UPDATE project_exports SET status='cancelled', object_key=NULL, updated_at=datetime('now') WHERE project_id=? AND status IN ('queued','running','completed')")
      .bind(projectId).run();
  }

  async createExport(input: { id: string; projectId: string; userId: string; targetLanguage: TargetLanguage; jobId: string; generation: number }): Promise<ExportVariant> {
    if (!(await this.ownsProject(input.projectId, input.userId))) throw new Error('Project not found.');
    await this.db.prepare(
      `INSERT INTO project_exports (id, project_id, target_language, status, job_id, generation) VALUES (?, ?, ?, 'queued', ?, ?)`,
    ).bind(input.id, input.projectId, input.targetLanguage, input.jobId, input.generation).run();
    return { id: input.id, projectId: input.projectId, targetLanguage: input.targetLanguage, status: 'queued', objectKey: null, jobId: input.jobId, errorCode: null, generation: input.generation };
  }

  async getExport(projectId: string, exportId: string, userId: string): Promise<ExportVariant | null> {
    if (!(await this.ownsProject(projectId, userId))) return null;
    const row = await this.db.prepare(
      `SELECT id, project_id, target_language, status, object_key, job_id, error_code, generation FROM project_exports WHERE project_id=? AND id=? LIMIT 1`,
    ).bind(projectId, exportId).first<ExportRow>();
    return row ? exportFromRow(row) : null;
  }

  async listExports(projectId: string, userId: string): Promise<ExportVariant[]> {
    if (!(await this.ownsProject(projectId, userId))) return [];
    const result = await this.db.prepare(
      `SELECT id, project_id, target_language, status, object_key, job_id, error_code, generation FROM project_exports WHERE project_id=? ORDER BY created_at DESC`,
    ).bind(projectId).all<ExportRow>();
    return (result.results ?? []).map(exportFromRow);
  }

  async setExportRunning(projectId: string, exportId: string, userId: string): Promise<void> {
    if (!(await this.ownsProject(projectId, userId))) throw new Error('Project not found.');
    await this.db.prepare("UPDATE project_exports SET status='running', error_code=NULL, updated_at=datetime('now') WHERE project_id=? AND id=?")
      .bind(projectId, exportId).run();
  }

  async completeExport(projectId: string, exportId: string, userId: string, objectKey: string): Promise<void> {
    if (!(await this.ownsProject(projectId, userId))) throw new Error('Project not found.');
    const current = await this.getExport(projectId, exportId, userId);
    if (!current) throw new Error('Export not found.');
    if (!objectKey.startsWith(`projects/${projectId}/exports/${current.targetLanguage}/${exportId}`)) {
      throw new Error('Export object key is outside the target export prefix.');
    }
    await this.db.prepare("UPDATE project_exports SET status='completed', object_key=?, error_code=NULL, updated_at=datetime('now') WHERE project_id=? AND id=?")
      .bind(objectKey, projectId, exportId).run();
  }

  async failExport(projectId: string, exportId: string, userId: string, errorCode: string): Promise<void> {
    if (!(await this.ownsProject(projectId, userId))) return;
    await this.db.prepare("UPDATE project_exports SET status='failed', error_code=?, updated_at=datetime('now') WHERE project_id=? AND id=?")
      .bind(errorCode, projectId, exportId).run();
  }

  async invalidateExportsForTarget(projectId: string, userId: string, targetLanguage: TargetLanguage): Promise<void> {
    if (!(await this.ownsProject(projectId, userId))) return;
    await this.db.prepare("UPDATE project_exports SET status='cancelled', object_key=NULL, updated_at=datetime('now') WHERE project_id=? AND target_language=? AND status IN ('queued','running','completed')")
      .bind(projectId, targetLanguage).run();
  }
}
