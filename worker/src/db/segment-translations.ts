import type { D1DatabaseLike } from './projects';
import type { TargetLanguage } from '../domain/language';

export type SegmentTranslation = {
  segmentId: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  translatedText: string;
  translationEngine: string;
  translationStatus: string;
  translationContextRevision: number | null;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
};

type SegmentTranslationRow = {
  segment_id: string;
  project_id: string;
  target_language: TargetLanguage;
  translated_text: string;
  translation_engine: string;
  translation_status: string;
  translation_context_revision: number | null;
  voice_status: string;
  dubbed_object_key: string | null;
  version: number;
};

function fromRow(row: SegmentTranslationRow): SegmentTranslation {
  return {
    segmentId: row.segment_id,
    projectId: row.project_id,
    targetLanguage: row.target_language,
    translatedText: row.translated_text,
    translationEngine: row.translation_engine,
    translationStatus: row.translation_status,
    translationContextRevision: row.translation_context_revision,
    voiceStatus: row.voice_status,
    dubbedObjectKey: row.dubbed_object_key,
    version: row.version,
  };
}

function changes(result: { meta?: { changes?: number }; changes?: number }): number {
  return result.meta?.changes ?? result.changes ?? 0;
}

export class SegmentTranslationPersistenceError extends Error {
  constructor(
    public readonly code: 'TRANSLATION_VARIANT_NOT_FOUND' | 'TRANSLATION_VARIANT_CONFLICT' | 'PROJECT_NOT_FOUND',
    message: string,
    public readonly canonical?: SegmentTranslation | null,
  ) {
    super(message);
    this.name = 'SegmentTranslationPersistenceError';
  }
}

export class SegmentTranslationRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async list(projectId: string, userId: string, target: TargetLanguage): Promise<SegmentTranslation[]> {
    const result = await this.db.prepare(
      `SELECT st.segment_id, st.project_id, st.target_language, st.translated_text,
              st.translation_engine, st.translation_status, st.translation_context_revision,
              st.voice_status, st.dubbed_object_key, st.version
       FROM segment_translations st
       JOIN projects p ON p.id = st.project_id
       WHERE st.project_id = ? AND st.target_language = ? AND p.user_id = ?
       ORDER BY st.segment_id ASC`,
    ).bind(projectId, target, userId).all<SegmentTranslationRow>();
    return (result.results ?? []).map(fromRow);
  }

  async get(projectId: string, segmentId: string, userId: string, target: TargetLanguage): Promise<SegmentTranslation | null> {
    const row = await this.db.prepare(
      `SELECT st.segment_id, st.project_id, st.target_language, st.translated_text,
              st.translation_engine, st.translation_status, st.translation_context_revision,
              st.voice_status, st.dubbed_object_key, st.version
       FROM segment_translations st
       JOIN projects p ON p.id = st.project_id
       WHERE st.project_id = ? AND st.segment_id = ? AND st.target_language = ? AND p.user_id = ?
       LIMIT 1`,
    ).bind(projectId, segmentId, target, userId).first<SegmentTranslationRow>();
    return row ? fromRow(row) : null;
  }

  private async assertProject(projectId: string, userId: string): Promise<void> {
    const row = await this.db.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<{ id: string }>();
    if (!row) throw new SegmentTranslationPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
  }

  private async invalidateTargetExports(projectId: string, target: TargetLanguage): Promise<void> {
    await this.db.prepare(
      `UPDATE project_exports
       SET status = 'invalidated', updated_at = datetime('now')
       WHERE project_id = ? AND target_language = ? AND status IN ('pending','exporting','completed','failed')`,
    ).bind(projectId, target).run();
  }

  private async mirrorVietnamese(projectId: string, segmentId: string, userId: string, text: string): Promise<void> {
    await this.db.prepare(
      `UPDATE segments
       SET translated_text = ?, translation_status = 'completed', voice_status = 'pending',
           dubbed_object_key = NULL, version = version + 1
       WHERE id = ? AND project_id = ?
         AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND user_id = ?)`,
    ).bind(text, segmentId, projectId, projectId, userId).run();
  }

  async updateText(
    projectId: string,
    segmentId: string,
    userId: string,
    target: TargetLanguage,
    expectedVersion: number,
    text: string,
  ): Promise<SegmentTranslation> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new SegmentTranslationPersistenceError('TRANSLATION_VARIANT_CONFLICT', 'Translation version must be a positive integer.');
    }
    const result = await this.db.prepare(
      `UPDATE segment_translations
       SET translated_text = ?, translation_status = 'completed', voice_status = 'pending',
           dubbed_object_key = NULL, version = version + 1, updated_at = datetime('now')
       WHERE segment_id = ? AND project_id = ? AND target_language = ?
         AND EXISTS (SELECT 1 FROM projects WHERE id = project_id AND user_id = ?)
         AND version = ?`,
    ).bind(text, segmentId, projectId, target, userId, expectedVersion).run();

    if (changes(result) !== 1) {
      const canonical = await this.get(projectId, segmentId, userId, target);
      if (!canonical) throw new SegmentTranslationPersistenceError('TRANSLATION_VARIANT_NOT_FOUND', 'Translation variant not found.');
      throw new SegmentTranslationPersistenceError('TRANSLATION_VARIANT_CONFLICT', 'Translation variant changed on the server.', canonical);
    }

    await this.invalidateTargetExports(projectId, target);
    if (target === 'vi') await this.mirrorVietnamese(projectId, segmentId, userId, text);
    const updated = await this.get(projectId, segmentId, userId, target);
    if (!updated) throw new SegmentTranslationPersistenceError('TRANSLATION_VARIANT_NOT_FOUND', 'Translation variant not found.');
    return updated;
  }

  async setTranslationResult(
    projectId: string,
    segmentId: string,
    userId: string,
    target: TargetLanguage,
    text: string,
    engine: 'workers-ai' | 'google',
    contextRevision: number | null,
  ): Promise<SegmentTranslation> {
    await this.assertProject(projectId, userId);
    const result = await this.db.prepare(
      `INSERT INTO segment_translations (
         segment_id, project_id, target_language, translated_text, translation_engine,
         translation_context_revision, translation_status, voice_status, dubbed_object_key, version
       ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'pending', NULL, 1)
       ON CONFLICT(segment_id, target_language) DO UPDATE SET
         translated_text = excluded.translated_text,
         translation_engine = excluded.translation_engine,
         translation_context_revision = excluded.translation_context_revision,
         translation_status = 'completed', voice_status = 'pending', dubbed_object_key = NULL,
         version = segment_translations.version + 1, updated_at = datetime('now')
       WHERE segment_translations.translation_status <> 'completed'`,
    ).bind(segmentId, projectId, target, text, engine, contextRevision).run();

    if (changes(result) > 0) {
      await this.invalidateTargetExports(projectId, target);
      if (target === 'vi') await this.mirrorVietnamese(projectId, segmentId, userId, text);
    }
    const translated = await this.get(projectId, segmentId, userId, target);
    if (!translated) throw new SegmentTranslationPersistenceError('TRANSLATION_VARIANT_NOT_FOUND', 'Translation variant not found.');
    return translated;
  }

  async setVoiceResult(
    projectId: string,
    segmentId: string,
    userId: string,
    target: TargetLanguage,
    objectKey: string,
  ): Promise<void> {
    await this.assertProject(projectId, userId);
    const result = await this.db.prepare(
      `UPDATE segment_translations
       SET voice_status = 'completed', dubbed_object_key = ?, updated_at = datetime('now')
       WHERE segment_id = ? AND project_id = ? AND target_language = ?`,
    ).bind(objectKey, segmentId, projectId, target).run();
    if (changes(result) === 0) throw new SegmentTranslationPersistenceError('TRANSLATION_VARIANT_NOT_FOUND', 'Translation variant not found.');
  }

  async invalidateForSourceSegment(projectId: string, segmentId: string, userId: string): Promise<void> {
    await this.assertProject(projectId, userId);
    await this.db.prepare(
      `UPDATE segment_translations
       SET translation_status = 'pending', voice_status = 'pending', dubbed_object_key = NULL,
           version = version + 1, updated_at = datetime('now')
       WHERE project_id = ? AND segment_id = ?`,
    ).bind(projectId, segmentId).run();
    await this.db.prepare(
      `UPDATE project_exports
       SET status = 'invalidated', updated_at = datetime('now')
       WHERE project_id = ? AND status IN ('pending','exporting','completed','failed')`,
    ).bind(projectId).run();
  }
}
