import type { D1DatabaseLike } from './projects';
import {
  normalizeAsrSegments,
  normalizeSegmentPatch,
  type PersistedAsrSegment,
  type SegmentPatch,
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
  version: number;
};

type SegmentRow = {
  id: string; project_id: string; speaker_id: string | null; start_ms: number; end_ms: number;
  source_text: string; translated_text: string; translation_engine: string; translation_status: string;
  voice_status: string; version: number;
};

function fromRow(row: SegmentRow): Segment {
  return {
    id: row.id, projectId: row.project_id, speakerId: row.speaker_id, startMs: row.start_ms, endMs: row.end_ms,
    sourceText: row.source_text, translatedText: row.translated_text, translationEngine: row.translation_engine,
    translationStatus: row.translation_status, voiceStatus: row.voice_status, version: row.version,
  };
}

export interface SegmentStore {
  list(projectId: string, userId: string): Promise<Segment[]>;
  get(projectId: string, segmentId: string, userId: string): Promise<Segment | null>;
  updateText(projectId: string, segmentId: string, userId: string, patch: SegmentPatch): Promise<Segment | null>;
  setTranslationResult(projectId: string, segmentId: string, userId: string, translatedText: string, engine: 'workers-ai' | 'google'): Promise<Segment | null>;
  replaceFromAsr(projectId: string, userId: string, segments: PersistedAsrSegment[]): Promise<Segment[]>;
}

export class SegmentPersistenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SegmentPersistenceError';
  }
}

const SELECT = `SELECT s.id, s.project_id, s.speaker_id, s.start_ms, s.end_ms, s.source_text, s.translated_text,
 s.translation_engine, s.translation_status, s.voice_status, s.version
 FROM segments s JOIN projects p ON p.id = s.project_id`;

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

  async updateText(projectId: string, segmentId: string, userId: string, rawPatch: SegmentPatch): Promise<Segment | null> {
    const current = await this.get(projectId, segmentId, userId);
    if (!current) return null;
    const patch = normalizeSegmentPatch(rawPatch, current);
    const next = {
      sourceText: patch.sourceText ?? current.sourceText,
      translatedText: patch.translatedText ?? current.translatedText,
      speakerId: patch.speakerId === undefined ? current.speakerId : patch.speakerId,
      startMs: patch.startMs ?? current.startMs,
      endMs: patch.endMs ?? current.endMs,
    };
    await this.db.prepare(`UPDATE segments SET source_text = ?, translated_text = ?, speaker_id = ?, start_ms = ?, end_ms = ?, version = version + 1
      WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
      .bind(next.sourceText, next.translatedText, next.speakerId, next.startMs, next.endMs, segmentId, projectId, userId).run();
    return this.get(projectId, segmentId, userId);
  }

  async setTranslationResult(projectId: string, segmentId: string, userId: string, translatedText: string, engine: 'workers-ai' | 'google'): Promise<Segment | null> {
    const current = await this.get(projectId, segmentId, userId);
    if (!current) return null;
    await this.db.prepare(`UPDATE segments SET translated_text = ?, translation_engine = ?, translation_status = 'completed', version = version + 1
      WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
      .bind(translatedText, engine, segmentId, projectId, userId).run();
    return this.get(projectId, segmentId, userId);
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

    const statements = [
      this.db.prepare(`DELETE FROM segments WHERE project_id = ?`).bind(projectId),
      ...segments.map((segment) => this.db.prepare(
        `INSERT INTO segments (
          id, project_id, speaker_id, start_ms, end_ms, source_text, translated_text,
          translation_engine, translation_status, voice_status, version
        ) VALUES (?, ?, NULL, ?, ?, ?, '', 'workers-ai', 'pending', 'pending', 1)`,
      ).bind(segment.id, projectId, segment.startMs, segment.endMs, segment.sourceText)),
    ];
    await this.db.batch(statements);
    return this.list(projectId, userId);
  }
}
