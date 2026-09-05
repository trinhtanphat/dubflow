import type { D1DatabaseLike } from './projects';
import {
  MIN_SEGMENT_MS,
  normalizeAsrSegments,
  normalizeSegmentPatch,
  normalizeSegmentRestoreInput,
  splitTextAtRatio,
  type PersistedAsrSegment,
  type SegmentPatch,
  type SegmentRestoreInput,
} from '../domain/segment';

export type Segment = {
  id: string;
  projectId: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
  translationEngine: string;
  translationStatus: string;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
  splitParentId: string | null;
};

type SegmentRow = {
  id: string; project_id: string; speaker_id: string | null; start_ms: number; end_ms: number;
  source_text: string; translated_text: string; translation_engine: string; translation_status: string;
  voice_status: string; dubbed_object_key?: string | null; version: number; split_parent_id?: string | null;
};

function fromRow(row: SegmentRow): Segment {
  return {
    id: row.id, projectId: row.project_id, speakerId: row.speaker_id, startMs: row.start_ms, endMs: row.end_ms,
    sourceText: row.source_text, translatedText: row.translated_text, translationEngine: row.translation_engine,
    translationStatus: row.translation_status, voiceStatus: row.voice_status, dubbedObjectKey: row.dubbed_object_key ?? null,
    version: row.version, splitParentId: row.split_parent_id ?? null,
  };
}

export interface SegmentStore {
  list(projectId: string, userId: string): Promise<Segment[]>;
  get(projectId: string, segmentId: string, userId: string): Promise<Segment | null>;
  updateText(projectId: string, segmentId: string, userId: string, patch: SegmentPatch): Promise<Segment | null>;
  updateSegment(projectId: string, segmentId: string, userId: string, patch: SegmentPatch): Promise<Segment | null>;
  splitSegment(projectId: string, segmentId: string, userId: string, playheadMs: number): Promise<{ left: Segment; right: Segment }>;
  restoreSplit(projectId: string, segmentId: string, childSegmentId: string, userId: string, original: SegmentRestoreInput): Promise<Segment>;
  setTranslationResult(projectId: string, segmentId: string, userId: string, translatedText: string, engine: 'workers-ai' | 'google'): Promise<Segment | null>;
  setVoiceResult(projectId: string, segmentId: string, userId: string, objectKey: string): Promise<void>;
  replaceFromAsr(projectId: string, userId: string, segments: PersistedAsrSegment[]): Promise<Segment[]>;
}

export class SegmentPersistenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SegmentPersistenceError';
  }
}

const SELECT = `SELECT s.id, s.project_id, s.speaker_id, s.start_ms, s.end_ms, s.source_text, s.translated_text,
 s.translation_engine, s.translation_status, s.voice_status, s.dubbed_object_key, s.version, s.split_parent_id
 FROM segments s JOIN projects p ON p.id = s.project_id`;

type AuthorizedProject = { id: string; duration_ms: number | null; status: string };

export class SegmentRepository implements SegmentStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async list(projectId: string, userId: string): Promise<Segment[]> {
    const result = await this.db.prepare(`${SELECT} WHERE s.project_id = ? AND p.user_id = ? ORDER BY s.start_ms, s.id`)
      .bind(projectId, userId).all<SegmentRow>();
    return (result.results ?? []).map(fromRow);
  }

  async get(projectId: string, segmentId: string, userId: string): Promise<Segment | null> {
    const row = await this.db.prepare(`${SELECT} WHERE s.project_id = ? AND s.id = ? AND p.user_id = ? LIMIT 1`)
      .bind(projectId, segmentId, userId).first<SegmentRow>();
    return row ? fromRow(row) : null;
  }

  private async getAuthorizedProject(projectId: string, userId: string): Promise<AuthorizedProject | null> {
    return this.db.prepare(`SELECT id, duration_ms, status FROM projects WHERE id = ? AND user_id = ? LIMIT 1`)
      .bind(projectId, userId).first<AuthorizedProject>();
  }

  private async assertEditorMutationAllowed(projectId: string, userId: string): Promise<AuthorizedProject> {
    const project = await this.getAuthorizedProject(projectId, userId);
    if (!project) throw new SegmentPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    if (project.status === 'processing') {
      throw new SegmentPersistenceError('PROJECT_BUSY', 'Project is locked while cloud processing or export is active.');
    }
    return project;
  }

  private invalidationStatement(projectId: string, userId: string) {
    return this.db.prepare(`UPDATE projects
      SET export_object_key = NULL, status = 'needs_review', updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`)
      .bind(projectId, userId);
  }

  private clearExportStatement(projectId: string, userId: string) {
    return this.db.prepare(`UPDATE projects
      SET export_object_key = NULL, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`)
      .bind(projectId, userId);
  }

  private async invalidatePublishedExport(projectId: string, userId: string): Promise<void> {
    await this.invalidationStatement(projectId, userId).run();
  }

  private async assertLegalTiming(
    projectId: string,
    userId: string,
    startMs: number,
    endMs: number,
    excludedSegmentIds: string[],
  ): Promise<void> {
    if (endMs - startMs < MIN_SEGMENT_MS) {
      throw new SegmentPersistenceError('SEGMENT_TOO_SHORT', `Segment duration must be at least ${MIN_SEGMENT_MS} ms.`);
    }

    const project = await this.getAuthorizedProject(projectId, userId);
    if (!project) throw new SegmentPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    if (!Number.isInteger(project.duration_ms) || (project.duration_ms as number) < 0) {
      throw new SegmentPersistenceError('PROJECT_DURATION_UNAVAILABLE', 'Project duration is required for timing edits.');
    }
    if (startMs < 0 || endMs > (project.duration_ms as number)) {
      throw new SegmentPersistenceError('SEGMENT_OUT_OF_BOUNDS', 'Segment timing must stay inside project duration.');
    }

    const excluded = new Set(excludedSegmentIds);
    const rows = await this.list(projectId, userId);
    const overlapping = rows.find((row) => !excluded.has(row.id) && startMs < row.endMs && endMs > row.startMs);
    if (overlapping) {
      throw new SegmentPersistenceError('SEGMENT_OVERLAP', `Segment overlaps ${overlapping.id}.`);
    }
  }

  async updateSegment(projectId: string, segmentId: string, userId: string, rawPatch: SegmentPatch): Promise<Segment | null> {
    const current = await this.get(projectId, segmentId, userId);
    if (!current) return null;
    await this.assertEditorMutationAllowed(projectId, userId);
    const patch = normalizeSegmentPatch(rawPatch, current);
    const next = {
      sourceText: patch.sourceText ?? current.sourceText,
      translatedText: patch.translatedText ?? current.translatedText,
      speakerId: patch.speakerId === undefined ? current.speakerId : patch.speakerId,
      startMs: patch.startMs ?? current.startMs,
      endMs: patch.endMs ?? current.endMs,
    };
    const timingChanged = next.startMs !== current.startMs || next.endMs !== current.endMs;
    const textOrSpeakerChanged = next.translatedText !== current.translatedText || next.speakerId !== current.speakerId;
    if (timingChanged) {
      await this.assertLegalTiming(projectId, userId, next.startMs, next.endMs, [segmentId]);
    }
    const invalidatesVoice = timingChanged || textOrSpeakerChanged;
    const voiceStatus = invalidatesVoice ? 'pending' : current.voiceStatus;
    const dubbedObjectKey = invalidatesVoice ? null : current.dubbedObjectKey;
    await this.db.prepare(`UPDATE segments
      SET source_text = ?, translated_text = ?, speaker_id = ?, start_ms = ?, end_ms = ?, voice_status = ?, dubbed_object_key = ?, version = version + 1
      WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
      .bind(next.sourceText, next.translatedText, next.speakerId, next.startMs, next.endMs, voiceStatus, dubbedObjectKey, segmentId, projectId, userId).run();
    if (invalidatesVoice) await this.invalidatePublishedExport(projectId, userId);
    return {
      ...current,
      ...next,
      voiceStatus,
      dubbedObjectKey,
      version: current.version + 1,
    };
  }

  async updateText(projectId: string, segmentId: string, userId: string, rawPatch: SegmentPatch): Promise<Segment | null> {
    return this.updateSegment(projectId, segmentId, userId, rawPatch);
  }

  async splitSegment(projectId: string, segmentId: string, userId: string, playheadMs: number): Promise<{ left: Segment; right: Segment }> {
    const current = await this.get(projectId, segmentId, userId);
    if (!current) throw new SegmentPersistenceError('SEGMENT_NOT_FOUND', 'Segment not found.');
    await this.assertEditorMutationAllowed(projectId, userId);
    if (!Number.isInteger(playheadMs)
      || playheadMs - current.startMs < MIN_SEGMENT_MS
      || current.endMs - playheadMs < MIN_SEGMENT_MS) {
      throw new SegmentPersistenceError('INVALID_SPLIT_POINT', `Split point must leave at least ${MIN_SEGMENT_MS} ms on both sides.`);
    }
    if (!this.db.batch) {
      throw new SegmentPersistenceError('D1_BATCH_UNAVAILABLE', 'Atomic D1 batch support is required for segment split.');
    }

    const ratio = (playheadMs - current.startMs) / (current.endMs - current.startMs);
    const source = splitTextAtRatio(current.sourceText, ratio);
    const translated = splitTextAtRatio(current.translatedText, ratio);
    const rightId = crypto.randomUUID();
    const left: Segment = {
      ...current,
      endMs: playheadMs,
      sourceText: source.left,
      translatedText: translated.left,
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version: current.version + 1,
    };
    const right: Segment = {
      ...current,
      id: rightId,
      startMs: playheadMs,
      sourceText: source.right,
      translatedText: translated.right,
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version: 1,
      splitParentId: current.id,
    };

    await this.db.batch([
      this.db.prepare(`UPDATE segments
        SET end_ms = ?, source_text = ?, translated_text = ?, voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
        WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
        .bind(left.endMs, left.sourceText, left.translatedText, segmentId, projectId, userId),
      this.db.prepare(`INSERT INTO segments (
        id, project_id, speaker_id, start_ms, end_ms, source_text, translated_text,
        translation_engine, translation_status, voice_status, dubbed_object_key, version, split_parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 1, ?)`)
        .bind(
          right.id,
          right.projectId,
          right.speakerId,
          right.startMs,
          right.endMs,
          right.sourceText,
          right.translatedText,
          right.translationEngine,
          right.translationStatus,
          current.id,
        ),
      this.invalidationStatement(projectId, userId),
    ]);
    return { left, right };
  }

  async restoreSplit(
    projectId: string,
    segmentId: string,
    childSegmentId: string,
    userId: string,
    rawOriginal: SegmentRestoreInput,
  ): Promise<Segment> {
    const current = await this.get(projectId, segmentId, userId);
    const child = await this.get(projectId, childSegmentId, userId);
    if (!current || !child) throw new SegmentPersistenceError('SEGMENT_NOT_FOUND', 'Segment not found.');
    await this.assertEditorMutationAllowed(projectId, userId);
    if (child.splitParentId !== segmentId) {
      throw new SegmentPersistenceError('SPLIT_LINEAGE_MISMATCH', 'Child segment does not belong to this split lineage.');
    }
    if (!this.db.batch) {
      throw new SegmentPersistenceError('D1_BATCH_UNAVAILABLE', 'Atomic D1 batch support is required for split restore.');
    }

    const original = normalizeSegmentRestoreInput(rawOriginal, current);
    await this.assertLegalTiming(projectId, userId, original.startMs, original.endMs, [segmentId, childSegmentId]);
    const restored: Segment = {
      ...current,
      ...original,
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version: current.version + 1,
    };

    await this.db.batch([
      this.db.prepare(`DELETE FROM segments
        WHERE id = ? AND project_id = ? AND split_parent_id = ?
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
        .bind(childSegmentId, projectId, segmentId, userId),
      this.db.prepare(`UPDATE segments
        SET source_text = ?, translated_text = ?, speaker_id = ?, start_ms = ?, end_ms = ?, voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
        WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
        .bind(
          restored.sourceText,
          restored.translatedText,
          restored.speakerId,
          restored.startMs,
          restored.endMs,
          segmentId,
          projectId,
          userId,
        ),
      this.invalidationStatement(projectId, userId),
    ]);
    return restored;
  }

  async setTranslationResult(projectId: string, segmentId: string, userId: string, translatedText: string, engine: 'workers-ai' | 'google'): Promise<Segment | null> {
    const current = await this.get(projectId, segmentId, userId);
    if (!current) return null;
    await this.db.prepare(`UPDATE segments SET translated_text = ?, translation_engine = ?, translation_status = 'completed', voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
      WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
      .bind(translatedText, engine, segmentId, projectId, userId).run();
    await this.invalidatePublishedExport(projectId, userId);
    return {
      ...current,
      translatedText,
      translationEngine: engine,
      translationStatus: 'completed',
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version: current.version + 1,
    };
  }

  async setVoiceResult(projectId: string, segmentId: string, userId: string, objectKey: string): Promise<void> {
    const prefix = `projects/${projectId}/dubbed/`;
    if (!objectKey.startsWith(prefix)) {
      throw new SegmentPersistenceError('VOICE_OBJECT_KEY_INVALID', 'Voice object key must belong to the project dubbed prefix.');
    }
    await this.db.prepare(`UPDATE segments SET dubbed_object_key = ?, voice_status = 'completed', version = version + 1
      WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
      .bind(objectKey, segmentId, projectId, userId).run();
  }

  async replaceFromAsr(projectId: string, userId: string, rawSegments: PersistedAsrSegment[]): Promise<Segment[]> {
    const segments = normalizeAsrSegments(rawSegments);
    const project = await this.db.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<{ id: string }>();
    if (!project) {
      throw new SegmentPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    }
    if (!this.db.batch) {
      throw new SegmentPersistenceError('D1_BATCH_UNAVAILABLE', 'Atomic D1 batch support is required for ASR replacement.');
    }

    const speakerIds = [...new Set(
      segments.map((segment) => segment.speakerId ?? null).filter((speakerId): speakerId is string => Boolean(speakerId)),
    )].sort();
    const speakerNames = new Map(speakerIds.map((speakerId, index) => [speakerId, `Nhân vật AI ${index + 1}`]));
    const statements = [
      this.db.prepare(`DELETE FROM segments WHERE project_id = ?`).bind(projectId),
      ...speakerIds.map((speakerId) => this.db.prepare(
        `INSERT INTO speakers (id, project_id, label, display_name)
         VALUES (?, ?, 'AI diarization', ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(speakerId, projectId, speakerNames.get(speakerId) ?? speakerId)),
      ...segments.map((segment) => this.db.prepare(
        `INSERT INTO segments (
          id, project_id, speaker_id, start_ms, end_ms, source_text, translated_text,
          translation_engine, translation_status, voice_status, dubbed_object_key, version
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'workers-ai', 'pending', 'pending', NULL, 1)`,
      ).bind(segment.id, projectId, segment.speakerId ?? null, segment.startMs, segment.endMs, segment.sourceText)),
      this.clearExportStatement(projectId, userId),
    ];
    await this.db.batch(statements);
    return segments.map((segment) => ({
      id: segment.id,
      projectId,
      speakerId: segment.speakerId ?? null,
      startMs: segment.startMs,
      endMs: segment.endMs,
      sourceText: segment.sourceText,
      translatedText: '',
      translationEngine: 'workers-ai',
      translationStatus: 'pending',
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version: 1,
      splitParentId: null,
    }));
  }
}
