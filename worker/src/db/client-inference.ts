import type { D1DatabaseLike, D1StatementLike } from './projects';
import {
  LOCAL_INFERENCE_ASR,
  LOCAL_INFERENCE_DURATION_TOLERANCE_MS,
  LOCAL_INFERENCE_MAX_SOURCE_BYTES,
  LOCAL_INFERENCE_TRANSLATION,
  browserLocalSpeakerId,
  type ClientInferenceInput,
} from '../domain/client-inference';

type ProjectRow = {
  id: string;
  source_language: string;
  target_language: string;
  source_generation: number;
  source_object_key: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
};

export class ClientInferenceCommitError extends Error {
  constructor(
    public readonly code: 'PROJECT_NOT_FOUND' | 'LOCAL_INFERENCE_SOURCE_CONFLICT' | 'LOCAL_INFERENCE_UNAVAILABLE' | 'LOCAL_INFERENCE_COMMIT_FAILED',
    message: string,
    public readonly source?: { sourceGeneration: number; sourceObjectKey: string | null },
  ) {
    super(message);
    this.name = 'ClientInferenceCommitError';
  }
}

function statement(db: D1DatabaseLike, sql: string, ...values: unknown[]): D1StatementLike {
  return db.prepare(sql).bind(...values);
}

export class ClientInferenceRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  private async requireProject(projectId: string, userId: string): Promise<ProjectRow> {
    const project = await this.db.prepare(
      `SELECT id, source_language, target_language, source_generation, source_object_key, duration_ms, size_bytes
       FROM projects
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
    ).bind(projectId, userId).first<ProjectRow>();
    if (!project) throw new ClientInferenceCommitError('PROJECT_NOT_FOUND', 'Project not found.');
    return project;
  }

  async commit(projectId: string, userId: string, input: ClientInferenceInput) {
    const project = await this.requireProject(projectId, userId);
    const currentGeneration = Number(project.source_generation ?? 1);
    const currentObjectKey = project.source_object_key ?? null;

    if (currentGeneration !== input.expectedSourceGeneration || currentObjectKey !== input.expectedSourceObjectKey) {
      throw new ClientInferenceCommitError(
        'LOCAL_INFERENCE_SOURCE_CONFLICT',
        'Project source changed before browser-local inference could be committed.',
        { sourceGeneration: currentGeneration, sourceObjectKey: currentObjectKey },
      );
    }
    if (project.source_language !== 'en' || project.target_language !== 'vi') {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Browser-local inference is currently available only for EN→VI projects.');
    }
    if (!currentObjectKey) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Project source media is unavailable.');
    }
    const sourceBytes = Number(project.size_bytes ?? 0);
    if (!Number.isFinite(sourceBytes) || sourceBytes <= 0 || sourceBytes > LOCAL_INFERENCE_MAX_SOURCE_BYTES) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Project source exceeds the browser-local inference size boundary.');
    }
    const currentDuration = project.duration_ms === null ? null : Number(project.duration_ms);
    if (currentDuration !== null && Number.isFinite(currentDuration)
        && Math.abs(currentDuration - input.durationMs) > LOCAL_INFERENCE_DURATION_TOLERANCE_MS) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_SOURCE_CONFLICT', 'Project source duration changed before commit.', {
        sourceGeneration: currentGeneration,
        sourceObjectKey: currentObjectKey,
      });
    }
    if (!this.db.batch) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_COMMIT_FAILED', 'Atomic D1 batch writes are unavailable.');
    }

    const speakerId = browserLocalSpeakerId(projectId);
    const translations = new Map(input.translations.map((item) => [item.segmentId, item.translatedText]));
    const writes: D1StatementLike[] = [
      statement(
        this.db,
        `UPDATE project_exports
         SET status = 'invalidated', updated_at = datetime('now')
         WHERE project_id = ? AND target_language = 'vi' AND status = 'completed'`,
        projectId,
      ),
      statement(this.db, `DELETE FROM segment_translations WHERE project_id = ? AND target_language = 'vi'`, projectId),
      statement(this.db, `DELETE FROM segments WHERE project_id = ?`, projectId),
      statement(
        this.db,
        `INSERT INTO speakers (id, project_id, label, display_name)
         VALUES (?, ?, 'Browser local', 'Speaker 1')
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           label = excluded.label,
           display_name = excluded.display_name`,
        speakerId,
        projectId,
      ),
    ];

    for (const segment of input.segments) {
      const translatedText = translations.get(segment.id)!;
      writes.push(statement(
        this.db,
        `INSERT INTO segments (
           id, project_id, speaker_id, start_ms, end_ms, source_text, translated_text,
           translation_engine, translation_context_revision, translation_status,
           voice_status, dubbed_object_key, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'browser-opus-mt', NULL, 'completed', 'pending', NULL, 1)`,
        segment.id,
        projectId,
        speakerId,
        segment.startMs,
        segment.endMs,
        segment.sourceText,
        translatedText,
      ));
      writes.push(statement(
        this.db,
        `INSERT INTO segment_translations (
           segment_id, project_id, target_language, translated_text, translation_engine,
           translation_status, translation_context_revision, voice_status, dubbed_object_key,
           version, context_revision, source_segment_version
         ) VALUES (?, ?, 'vi', ?, 'browser-opus-mt', 'completed', NULL, 'pending', NULL, 1, NULL, 1)`,
        segment.id,
        projectId,
        translatedText,
      ));
    }

    writes.push(
      statement(
        this.db,
        `UPDATE project_target_languages
         SET status = 'needs_review', updated_at = datetime('now')
         WHERE project_id = ? AND target_language = 'vi'`,
        projectId,
      ),
      statement(
        this.db,
        `UPDATE projects
         SET status = 'needs_review', duration_ms = ?, export_object_key = NULL, updated_at = datetime('now')
         WHERE id = ? AND user_id = ? AND source_generation = ? AND source_object_key = ?`,
        input.durationMs,
        projectId,
        userId,
        input.expectedSourceGeneration,
        input.expectedSourceObjectKey,
      ),
    );

    try {
      await this.db.batch(writes);
    } catch (error) {
      throw new ClientInferenceCommitError(
        'LOCAL_INFERENCE_COMMIT_FAILED',
        error instanceof Error ? `Atomic browser-local inference commit failed: ${error.message}` : 'Atomic browser-local inference commit failed.',
      );
    }

    return {
      projectId,
      sourceGeneration: currentGeneration,
      sourceObjectKey: currentObjectKey,
      durationMs: input.durationMs,
      speaker: { id: speakerId, label: 'Browser local', displayName: 'Speaker 1' },
      segments: input.segments.map((segment) => ({
        ...segment,
        speakerId,
        translatedText: translations.get(segment.id)!,
        translationEngine: 'browser-opus-mt' as const,
        translationStatus: 'completed' as const,
        voiceStatus: 'pending' as const,
        dubbedObjectKey: null,
        version: 1,
      })),
      translations: input.translations.map((translation) => ({
        ...translation,
        targetLanguage: 'vi' as const,
        translationEngine: 'browser-opus-mt' as const,
        translationStatus: 'completed' as const,
        voiceStatus: 'pending' as const,
        dubbedObjectKey: null,
        version: 1,
        sourceSegmentVersion: 1,
      })),
      asr: LOCAL_INFERENCE_ASR,
      translation: LOCAL_INFERENCE_TRANSLATION,
    };
  }
}
