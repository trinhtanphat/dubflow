import type { D1DatabaseLike, D1StatementLike } from './projects';
import {
  LOCAL_INFERENCE_ASR,
  LOCAL_INFERENCE_DURATION_TOLERANCE_MS,
  LOCAL_INFERENCE_MAX_DURATION_MS,
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
  status: string;
  translation_context_revision: number | null;
};

type TargetRow = { status: string };
type BusyExportRow = { busy_count: number };
type ClientInferenceStateRow = {
  source_generation: number;
  source_object_key: string;
  asr_model: string;
  asr_revision: string;
  translation_model: string;
  translation_revision: string;
};

export type ClientInferenceState = {
  sourceGeneration: number;
  sourceObjectKey: string;
  asr: typeof LOCAL_INFERENCE_ASR;
  translation: typeof LOCAL_INFERENCE_TRANSLATION;
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

function sourceGuardSql(): string {
  return `EXISTS (
    SELECT 1
    FROM projects AS source_guard
    WHERE source_guard.id = ?
      AND source_guard.user_id = ?
      AND source_guard.source_generation = ?
      AND source_guard.source_object_key = ?
  )`;
}

function sourceGuardValues(projectId: string, userId: string, input: ClientInferenceInput): unknown[] {
  return [projectId, userId, input.expectedSourceGeneration, input.expectedSourceObjectKey];
}

export class ClientInferenceRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  private async requireProject(projectId: string, userId: string): Promise<ProjectRow> {
    const project = await this.db.prepare(
      `SELECT id, source_language, target_language, source_generation, source_object_key,
              duration_ms, size_bytes, status, translation_context_revision
       FROM projects
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
    ).bind(projectId, userId).first<ProjectRow>();
    if (!project) throw new ClientInferenceCommitError('PROJECT_NOT_FOUND', 'Project not found.');
    return project;
  }

  async getState(projectId: string, userId: string): Promise<ClientInferenceState | null> {
    await this.requireProject(projectId, userId);
    const row = await this.db.prepare(
      `SELECT state.source_generation, state.source_object_key,
              state.asr_model, state.asr_revision,
              state.translation_model, state.translation_revision
       FROM browser_local_inference_state AS state
       INNER JOIN projects AS project ON project.id = state.project_id
       WHERE state.project_id = ?
         AND project.user_id = ?
         AND state.source_generation = project.source_generation
         AND state.source_object_key = project.source_object_key
       LIMIT 1`,
    ).bind(projectId, userId).first<ClientInferenceStateRow>();
    if (!row) return null;
    if (row.asr_model !== LOCAL_INFERENCE_ASR.model
      || row.asr_revision !== LOCAL_INFERENCE_ASR.revision
      || row.translation_model !== LOCAL_INFERENCE_TRANSLATION.model
      || row.translation_revision !== LOCAL_INFERENCE_TRANSLATION.revision) {
      return null;
    }
    return {
      sourceGeneration: Number(row.source_generation),
      sourceObjectKey: row.source_object_key,
      asr: LOCAL_INFERENCE_ASR,
      translation: LOCAL_INFERENCE_TRANSLATION,
    };
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
    if (currentDuration !== null) {
      if (!Number.isFinite(currentDuration) || currentDuration <= 0 || currentDuration > LOCAL_INFERENCE_MAX_DURATION_MS) {
        throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Project source duration exceeds the browser-local inference duration boundary.');
      }
      if (Math.abs(currentDuration - input.durationMs) > LOCAL_INFERENCE_DURATION_TOLERANCE_MS) {
        throw new ClientInferenceCommitError('LOCAL_INFERENCE_SOURCE_CONFLICT', 'Project source duration changed before commit.', {
          sourceGeneration: currentGeneration,
          sourceObjectKey: currentObjectKey,
        });
      }
    }
    if (project.status === 'processing') {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Project is currently processing.');
    }

    const target = await this.db.prepare(
      `SELECT status
       FROM project_target_languages
       WHERE project_id = ? AND target_language = 'vi'
       LIMIT 1`,
    ).bind(projectId).first<TargetRow>();
    if (!target) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Vietnamese is not enabled for this project.');
    }
    if (target.status === 'translating' || target.status === 'exporting') {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Vietnamese target is currently busy.');
    }

    const busyExport = await this.db.prepare(
      `SELECT COUNT(*) AS busy_count
       FROM project_exports
       WHERE project_id = ? AND status IN ('pending','exporting')`,
    ).bind(projectId).first<BusyExportRow>();
    if (Number(busyExport?.busy_count ?? 0) > 0) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'A project export is currently active.');
    }

    if (!this.db.batch) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_COMMIT_FAILED', 'Atomic D1 batch writes are unavailable.');
    }

    const contextRevision = Number(project.translation_context_revision ?? 1);
    if (!Number.isInteger(contextRevision) || contextRevision < 1) {
      throw new ClientInferenceCommitError('LOCAL_INFERENCE_UNAVAILABLE', 'Project translation context revision is invalid.');
    }

    const guard = sourceGuardSql();
    const guardValues = sourceGuardValues(projectId, userId, input);
    const speakerId = browserLocalSpeakerId(projectId);
    const translations = new Map(input.translations.map((item) => [item.segmentId, item.translatedText]));
    const writes: D1StatementLike[] = [
      statement(
        this.db,
        `UPDATE project_exports
         SET status = 'invalidated', updated_at = datetime('now')
         WHERE project_id = ? AND status IN ('completed','failed') AND ${guard}`,
        projectId,
        ...guardValues,
      ),
      statement(
        this.db,
        `DELETE FROM segment_translations
         WHERE project_id = ? AND target_language = 'vi' AND ${guard}`,
        projectId,
        ...guardValues,
      ),
      statement(
        this.db,
        `DELETE FROM segment_dubs
         WHERE project_id = ? AND target_language = 'vi' AND ${guard}`,
        projectId,
        ...guardValues,
      ),
      statement(
        this.db,
        `DELETE FROM segments WHERE project_id = ? AND ${guard}`,
        projectId,
        ...guardValues,
      ),
      statement(
        this.db,
        `DELETE FROM speakers WHERE project_id = ? AND ${guard}`,
        projectId,
        ...guardValues,
      ),
      statement(
        this.db,
        `DELETE FROM browser_local_inference_state WHERE project_id = ? AND ${guard}`,
        projectId,
        ...guardValues,
      ),
      statement(
        this.db,
        `INSERT INTO speakers (id, project_id, label, display_name)
         SELECT ?, ?, 'Browser local', 'Speaker 1'
         WHERE ${guard}`,
        speakerId,
        projectId,
        ...guardValues,
      ),
    ];

    for (const segment of input.segments) {
      const translatedText = translations.get(segment.id);
      if (!translatedText) {
        throw new ClientInferenceCommitError('LOCAL_INFERENCE_COMMIT_FAILED', 'Validated translation set is incomplete.');
      }
      writes.push(statement(
        this.db,
        `INSERT INTO segments (
           id, project_id, speaker_id, start_ms, end_ms, source_text, translated_text,
           translation_engine, translation_context_revision, translation_status,
           voice_status, dubbed_object_key, version, split_parent_id
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, 'browser-opus-mt', ?, 'completed', 'pending', NULL, 1, NULL
         WHERE ${guard}`,
        segment.id,
        projectId,
        speakerId,
        segment.startMs,
        segment.endMs,
        segment.sourceText,
        translatedText,
        contextRevision,
        ...guardValues,
      ));
      writes.push(statement(
        this.db,
        `INSERT INTO segment_translations (
           segment_id, project_id, target_language, translated_text, translation_engine,
           translation_status, translation_context_revision, voice_status, dubbed_object_key,
           version, context_revision, source_segment_version
         )
         SELECT ?, ?, 'vi', ?, 'browser-opus-mt', 'completed', ?, 'pending', NULL, 1, ?, 1
         WHERE ${guard}`,
        segment.id,
        projectId,
        translatedText,
        contextRevision,
        contextRevision,
        ...guardValues,
      ));
    }

    writes.push(
      statement(
        this.db,
        `INSERT INTO browser_local_inference_state (
           project_id, source_generation, source_object_key,
           asr_model, asr_revision, translation_model, translation_revision
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE ${guard}`,
        projectId,
        input.expectedSourceGeneration,
        input.expectedSourceObjectKey,
        LOCAL_INFERENCE_ASR.model,
        LOCAL_INFERENCE_ASR.revision,
        LOCAL_INFERENCE_TRANSLATION.model,
        LOCAL_INFERENCE_TRANSLATION.revision,
        ...guardValues,
      ),
      statement(
        this.db,
        `UPDATE project_target_languages
         SET status = 'needs_review', updated_at = datetime('now')
         WHERE project_id = ? AND target_language = 'vi' AND ${guard}`,
        projectId,
        ...guardValues,
      ),
      statement(
        this.db,
        `UPDATE projects
         SET status = 'needs_review',
             duration_ms = CASE WHEN duration_ms IS NULL OR duration_ms <= 0 THEN ? ELSE duration_ms END,
             export_object_key = NULL,
             updated_at = datetime('now')
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
    } catch {
      throw new ClientInferenceCommitError(
        'LOCAL_INFERENCE_COMMIT_FAILED',
        'Atomic browser-local inference commit failed.',
      );
    }

    const committedProject = await this.requireProject(projectId, userId);
    const committedGeneration = Number(committedProject.source_generation ?? 1);
    const committedObjectKey = committedProject.source_object_key ?? null;
    if (committedGeneration !== input.expectedSourceGeneration || committedObjectKey !== input.expectedSourceObjectKey) {
      throw new ClientInferenceCommitError(
        'LOCAL_INFERENCE_SOURCE_CONFLICT',
        'Project source changed before browser-local inference could be committed.',
        { sourceGeneration: committedGeneration, sourceObjectKey: committedObjectKey },
      );
    }

    return {
      projectId,
      sourceGeneration: committedGeneration,
      sourceObjectKey: committedObjectKey,
      durationMs: currentDuration ?? input.durationMs,
      speaker: { id: speakerId, label: 'Browser local', displayName: 'Speaker 1' },
      segments: input.segments.map((segment) => ({
        ...segment,
        speakerId,
        translatedText: translations.get(segment.id)!,
        translationEngine: 'browser-opus-mt' as const,
        translationStatus: 'completed' as const,
        translationContextRevision: contextRevision,
        voiceStatus: 'pending' as const,
        dubbedObjectKey: null,
        version: 1,
      })),
      translations: input.translations.map((translation) => ({
        ...translation,
        targetLanguage: 'vi' as const,
        translationEngine: 'browser-opus-mt' as const,
        translationStatus: 'completed' as const,
        translationContextRevision: contextRevision,
        contextRevision,
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
