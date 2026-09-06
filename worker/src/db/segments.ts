import type { D1DatabaseLike, D1RunResultLike } from './projects';
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
  translationContextRevision: number | null;
  translationStatus: string;
  voiceStatus: string;
  dubbedObjectKey: string | null;
  version: number;
  splitParentId: string | null;
};

type SegmentRow = {
  id: string; project_id: string; speaker_id: string | null; start_ms: number; end_ms: number;
  source_text: string; translated_text: string; translation_engine: string; translation_context_revision?: number | null;
  translation_status: string; voice_status: string; dubbed_object_key?: string | null; version: number; split_parent_id?: string | null;
};

type SegmentTranslationVariantRow = {
  segment_id: string;
  project_id: string;
  target_language: 'vi' | 'en' | 'zh' | 'ja' | 'ko';
  translated_text: string;
  translation_engine: string;
  translation_status: string;
  translation_context_revision: number | null;
  voice_status: string;
  dubbed_object_key: string | null;
  version: number;
};

function fromRow(row: SegmentRow): Segment {
  return {
    id: row.id, projectId: row.project_id, speakerId: row.speaker_id, startMs: row.start_ms, endMs: row.end_ms,
    sourceText: row.source_text, translatedText: row.translated_text, translationEngine: row.translation_engine,
    translationContextRevision: row.translation_context_revision ?? null,
    translationStatus: row.translation_status, voiceStatus: row.voice_status, dubbedObjectKey: row.dubbed_object_key ?? null,
    version: row.version, splitParentId: row.split_parent_id ?? null,
  };
}

export interface SegmentStore {
  list(projectId: string, userId: string): Promise<Segment[]>;
  get(projectId: string, segmentId: string, userId: string): Promise<Segment | null>;
  updateText(projectId: string, segmentId: string, userId: string, expectedVersion: number, patch: SegmentPatch): Promise<Segment | null>;
  updateSegment(projectId: string, segmentId: string, userId: string, expectedVersion: number, patch: SegmentPatch): Promise<Segment | null>;
  splitSegment(projectId: string, segmentId: string, userId: string, expectedVersion: number, playheadMs: number): Promise<{ left: Segment; right: Segment }>;
  restoreSplit(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    childSegmentId: string,
    expectedChildVersion: number,
    original: SegmentRestoreInput,
  ): Promise<Segment>;
  setTranslationResult(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    translatedText: string,
    engine: 'workers-ai' | 'google',
    contextRevision?: number | null,
  ): Promise<Segment | null>;
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
 s.translation_engine, s.translation_context_revision, s.translation_status, s.voice_status, s.dubbed_object_key, s.version, s.split_parent_id
 FROM segments s JOIN projects p ON p.id = s.project_id`;

type AuthorizedProject = { id: string; duration_ms: number | null; status: string };

function affectedRows(result: D1RunResultLike): number {
  const changes = result.meta?.changes ?? result.changes ?? 0;
  return Number.isFinite(changes) ? Math.max(0, Number(changes)) : 0;
}

function requireExpectedVersion(expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new SegmentPersistenceError('INVALID_SEGMENT_VERSION', 'expectedVersion must be a positive integer.');
  }
}

function normalizeContextRevision(contextRevision: number | null | undefined): number | null {
  if (contextRevision === undefined || contextRevision === null) return null;
  if (!Number.isInteger(contextRevision) || contextRevision < 1) {
    throw new SegmentPersistenceError(
      'INVALID_TRANSLATION_CONTEXT_REVISION',
      'translation context revision must be a positive integer when provided.',
    );
  }
  return contextRevision;
}

function joinSplitVariantText(left: string, right: string): string {
  const first = left.trim();
  const second = right.trim();
  if (!first) return second;
  if (!second) return first;
  return `${first} ${second}`;
}

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

  private async listTranslationVariants(projectId: string, segmentId: string): Promise<SegmentTranslationVariantRow[]> {
    const result = await this.db.prepare(
      `SELECT segment_id, project_id, target_language, translated_text, translation_engine,
              translation_status, translation_context_revision, voice_status, dubbed_object_key, version
       FROM segment_translations
       WHERE project_id = ? AND segment_id = ?
       ORDER BY target_language`,
    ).bind(projectId, segmentId).all<SegmentTranslationVariantRow>();
    return result.results ?? [];
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

  private invalidateAllVariantTranslationsStatement(projectId: string, segmentId: string) {
    return this.db.prepare(`UPDATE segment_translations
      SET translation_status = 'pending', voice_status = 'pending', dubbed_object_key = NULL,
          version = version + 1, updated_at = datetime('now')
      WHERE project_id = ? AND segment_id = ?`)
      .bind(projectId, segmentId);
  }

  private invalidateVariantVoicesStatement(projectId: string, segmentId: string) {
    return this.db.prepare(`UPDATE segment_translations
      SET voice_status = 'pending', dubbed_object_key = NULL, updated_at = datetime('now')
      WHERE project_id = ? AND segment_id = ?`)
      .bind(projectId, segmentId);
  }

  private invalidateAllTargetExportsStatement(projectId: string) {
    return this.db.prepare(`UPDATE project_exports
      SET status = 'invalidated', updated_at = datetime('now')
      WHERE project_id = ? AND status IN ('pending','exporting','completed','failed')`)
      .bind(projectId);
  }

  private invalidateDubbedTargetExportsStatement(projectId: string) {
    return this.db.prepare(`UPDATE project_exports
      SET status = 'invalidated', updated_at = datetime('now')
      WHERE project_id = ? AND output = 'dubbed'
        AND status IN ('pending','exporting','completed','failed')`)
      .bind(projectId);
  }

  private invalidateTargetExportsStatement(projectId: string, targetLanguage: string) {
    return this.db.prepare(`UPDATE project_exports
      SET status = 'invalidated', updated_at = datetime('now')
      WHERE project_id = ? AND target_language = ?
        AND status IN ('pending','exporting','completed','failed')`)
      .bind(projectId, targetLanguage);
  }

  private syncVietnameseVariantStatement(
    projectId: string,
    segmentId: string,
    translatedText: string,
    engine: 'workers-ai' | 'google',
    contextRevision: number | null,
  ) {
    return this.db.prepare(`INSERT INTO segment_translations (
        segment_id, project_id, target_language, translated_text, translation_engine,
        translation_context_revision, translation_status, voice_status, dubbed_object_key, version
      ) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'pending', NULL, 1)
      ON CONFLICT(segment_id, target_language) DO UPDATE SET
        translated_text = excluded.translated_text,
        translation_engine = excluded.translation_engine,
        translation_context_revision = excluded.translation_context_revision,
        translation_status = 'completed', voice_status = 'pending', dubbed_object_key = NULL,
        version = segment_translations.version + 1, updated_at = datetime('now')`)
      .bind(segmentId, projectId, 'vi', translatedText, engine, contextRevision);
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

  async updateSegment(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    rawPatch: SegmentPatch,
  ): Promise<Segment | null> {
    requireExpectedVersion(expectedVersion);
    const current = await this.get(projectId, segmentId, userId);
    if (!current) return null;
    await this.assertEditorMutationAllowed(projectId, userId);
    if (current.version !== expectedVersion) {
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
    const patch = normalizeSegmentPatch(rawPatch, current);
    const next = {
      sourceText: patch.sourceText ?? current.sourceText,
      translatedText: patch.translatedText ?? current.translatedText,
      speakerId: patch.speakerId === undefined ? current.speakerId : patch.speakerId,
      startMs: patch.startMs ?? current.startMs,
      endMs: patch.endMs ?? current.endMs,
    };
    const sourceChanged = next.sourceText !== current.sourceText;
    const translatedChanged = next.translatedText !== current.translatedText;
    const speakerChanged = next.speakerId !== current.speakerId;
    const timingChanged = next.startMs !== current.startMs || next.endMs !== current.endMs;
    if (timingChanged) {
      await this.assertLegalTiming(projectId, userId, next.startMs, next.endMs, [segmentId]);
    }
    const invalidatesVoice = sourceChanged || translatedChanged || speakerChanged || timingChanged;
    const voiceStatus = invalidatesVoice ? 'pending' : current.voiceStatus;
    const dubbedObjectKey = invalidatesVoice ? null : current.dubbedObjectKey;
    const result = await this.db.prepare(`UPDATE segments
      SET source_text = ?, translated_text = ?, speaker_id = ?, start_ms = ?, end_ms = ?, voice_status = ?, dubbed_object_key = ?, version = version + 1
      WHERE id = ? AND project_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)
      AND version = ?`)
      .bind(
        next.sourceText,
        next.translatedText,
        next.speakerId,
        next.startMs,
        next.endMs,
        voiceStatus,
        dubbedObjectKey,
        segmentId,
        projectId,
        userId,
        expectedVersion,
      ).run();
    if (affectedRows(result) === 0) {
      const canonical = await this.get(projectId, segmentId, userId);
      if (!canonical) return null;
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }

    const variants = invalidatesVoice || sourceChanged
      ? await this.listTranslationVariants(projectId, segmentId)
      : [];
    if (variants.length > 0) {
      if (sourceChanged) {
        await this.db.prepare(`UPDATE segments SET translation_status = 'pending'
          WHERE id = ? AND project_id = ?
            AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
          .bind(segmentId, projectId, userId).run();
        await this.invalidateAllVariantTranslationsStatement(projectId, segmentId).run();
        await this.invalidateAllTargetExportsStatement(projectId).run();
      } else {
        if (timingChanged || speakerChanged) {
          await this.invalidateVariantVoicesStatement(projectId, segmentId).run();
          await this.invalidateDubbedTargetExportsStatement(projectId).run();
        }
        if (translatedChanged) {
          await this.syncVietnameseVariantStatement(
            projectId,
            segmentId,
            next.translatedText,
            current.translationEngine === 'google' ? 'google' : 'workers-ai',
            current.translationContextRevision,
          ).run();
          await this.invalidateTargetExportsStatement(projectId, 'vi').run();
        }
      }
    }

    if (invalidatesVoice) await this.invalidatePublishedExport(projectId, userId);
    const canonical = await this.get(projectId, segmentId, userId);
    if (!canonical) throw new SegmentPersistenceError('SEGMENT_NOT_FOUND', 'Segment not found after update.');
    return canonical;
  }

  async updateText(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    rawPatch: SegmentPatch,
  ): Promise<Segment | null> {
    return this.updateSegment(projectId, segmentId, userId, expectedVersion, rawPatch);
  }

  async splitSegment(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    playheadMs: number,
  ): Promise<{ left: Segment; right: Segment }> {
    requireExpectedVersion(expectedVersion);
    const current = await this.get(projectId, segmentId, userId);
    if (!current) throw new SegmentPersistenceError('SEGMENT_NOT_FOUND', 'Segment not found.');
    await this.assertEditorMutationAllowed(projectId, userId);
    if (current.version !== expectedVersion) {
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
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
      version: expectedVersion + 1,
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
    const variants = await this.listTranslationVariants(projectId, segmentId);
    const variantStatements = variants.flatMap((variant) => {
      const split = splitTextAtRatio(variant.translated_text, ratio);
      return [
        this.db.prepare(`UPDATE segment_translations
          SET translated_text = ?, voice_status = 'pending', dubbed_object_key = NULL,
              version = version + 1, updated_at = datetime('now')
          WHERE project_id = ? AND segment_id = ? AND target_language = ?`)
          .bind(split.left, projectId, segmentId, variant.target_language),
        this.db.prepare(`INSERT INTO segment_translations (
          segment_id, project_id, target_language, translated_text, translation_engine,
          translation_status, translation_context_revision, voice_status, dubbed_object_key, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 1)`)
          .bind(
            rightId,
            projectId,
            variant.target_language,
            split.right,
            variant.translation_engine,
            variant.translation_status,
            variant.translation_context_revision,
          ),
      ];
    });

    const results = await this.db.batch([
      this.db.prepare(`UPDATE segments
        SET end_ms = ?, source_text = ?, translated_text = ?, voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
        WHERE id = ? AND project_id = ?
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)
        AND version = ?`)
        .bind(left.endMs, left.sourceText, left.translatedText, segmentId, projectId, userId, expectedVersion),
      this.db.prepare(`INSERT INTO segments (
        id, project_id, speaker_id, start_ms, end_ms, source_text, translated_text,
        translation_engine, translation_context_revision, translation_status, voice_status, dubbed_object_key, version, split_parent_id
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 1, ?
        WHERE EXISTS (
          SELECT 1 FROM segments s JOIN projects p ON p.id = s.project_id
          WHERE s.id = ? AND s.project_id = ? AND p.user_id = ? AND s.version = ?
        )`)
        .bind(
          right.id,
          right.projectId,
          right.speakerId,
          right.startMs,
          right.endMs,
          right.sourceText,
          right.translatedText,
          right.translationEngine,
          right.translationContextRevision,
          right.translationStatus,
          current.id,
          current.id,
          projectId,
          userId,
          expectedVersion + 1,
        ),
      ...variantStatements,
      this.invalidationStatement(projectId, userId),
    ]) as D1RunResultLike[];
    if (affectedRows(results[0] ?? {}) !== 1 || affectedRows(results[1] ?? {}) !== 1) {
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
    if (variants.length > 0) await this.invalidateAllTargetExportsStatement(projectId).run();
    return { left, right };
  }

  async restoreSplit(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    childSegmentId: string,
    expectedChildVersion: number,
    rawOriginal: SegmentRestoreInput,
  ): Promise<Segment> {
    requireExpectedVersion(expectedVersion);
    requireExpectedVersion(expectedChildVersion);
    const current = await this.get(projectId, segmentId, userId);
    const child = await this.get(projectId, childSegmentId, userId);
    if (!current || !child) throw new SegmentPersistenceError('SEGMENT_NOT_FOUND', 'Segment not found.');
    await this.assertEditorMutationAllowed(projectId, userId);
    if (current.version !== expectedVersion || child.version !== expectedChildVersion) {
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
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
      version: expectedVersion + 1,
    };
    const parentVariants = await this.listTranslationVariants(projectId, segmentId);
    const childVariants = await this.listTranslationVariants(projectId, childSegmentId);
    const childrenByTarget = new Map(childVariants.map((variant) => [variant.target_language, variant]));
    const variantStatements = parentVariants.map((variant) => {
      const childVariant = childrenByTarget.get(variant.target_language);
      const restoredText = childVariant
        ? joinSplitVariantText(variant.translated_text, childVariant.translated_text)
        : variant.translated_text;
      return this.db.prepare(`UPDATE segment_translations
        SET translated_text = ?, translation_status = 'pending', voice_status = 'pending', dubbed_object_key = NULL,
            version = version + 1, updated_at = datetime('now')
        WHERE project_id = ? AND segment_id = ? AND target_language = ?`)
        .bind(restoredText, projectId, segmentId, variant.target_language);
    });
    if (childVariants.length > 0) {
      variantStatements.push(
        this.db.prepare(`DELETE FROM segment_translations WHERE project_id = ? AND segment_id = ?`)
          .bind(projectId, childSegmentId),
      );
    }

    const results = await this.db.batch([
      this.db.prepare(`UPDATE segments
        SET source_text = ?, translated_text = ?, speaker_id = ?, start_ms = ?, end_ms = ?, voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
        WHERE id = ? AND project_id = ?
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)
        AND version = ?
        AND EXISTS (
          SELECT 1 FROM segments child
          WHERE child.id = ? AND child.project_id = project_id
          AND child.split_parent_id = id AND child.version = ?
        )`)
        .bind(
          restored.sourceText,
          restored.translatedText,
          restored.speakerId,
          restored.startMs,
          restored.endMs,
          segmentId,
          projectId,
          userId,
          expectedVersion,
          childSegmentId,
          expectedChildVersion,
        ),
      this.db.prepare(`DELETE FROM segments
        WHERE id = ? AND project_id = ? AND split_parent_id = ? AND version = ?
        AND EXISTS (
          SELECT 1 FROM segments parent JOIN projects p ON p.id = parent.project_id
          WHERE parent.id = ? AND parent.project_id = ? AND p.user_id = ? AND parent.version = ?
        )`)
        .bind(
          childSegmentId,
          projectId,
          segmentId,
          expectedChildVersion,
          segmentId,
          projectId,
          userId,
          expectedVersion + 1,
        ),
      ...variantStatements,
      this.invalidationStatement(projectId, userId),
    ]) as D1RunResultLike[];
    if (affectedRows(results[0] ?? {}) !== 1 || affectedRows(results[1] ?? {}) !== 1) {
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
    if (parentVariants.length > 0 || childVariants.length > 0) {
      await this.invalidateAllTargetExportsStatement(projectId).run();
    }
    return restored;
  }

  async setTranslationResult(
    projectId: string,
    segmentId: string,
    userId: string,
    expectedVersion: number,
    translatedText: string,
    engine: 'workers-ai' | 'google',
    contextRevision?: number | null,
  ): Promise<Segment | null> {
    requireExpectedVersion(expectedVersion);
    const normalizedContextRevision = normalizeContextRevision(contextRevision);
    const current = await this.get(projectId, segmentId, userId);
    if (!current) return null;
    if (current.version !== expectedVersion) {
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
    const result = await this.db.prepare(`UPDATE segments
      SET translated_text = ?, translation_engine = ?, translation_context_revision = ?, translation_status = 'completed', voice_status = 'pending', dubbed_object_key = NULL, version = version + 1
      WHERE id = ? AND project_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)
      AND version = ?`)
      .bind(translatedText, engine, normalizedContextRevision, segmentId, projectId, userId, expectedVersion).run();
    if (affectedRows(result) === 0) {
      const canonical = await this.get(projectId, segmentId, userId);
      if (!canonical) return null;
      throw new SegmentPersistenceError('SEGMENT_VERSION_CONFLICT', 'Segment changed elsewhere.');
    }
    const variants = await this.listTranslationVariants(projectId, segmentId);
    if (variants.length > 0) {
      await this.syncVietnameseVariantStatement(
        projectId,
        segmentId,
        translatedText,
        engine,
        normalizedContextRevision,
      ).run();
      await this.invalidateTargetExportsStatement(projectId, 'vi').run();
    }
    await this.invalidatePublishedExport(projectId, userId);
    const canonical = await this.get(projectId, segmentId, userId);
    if (!canonical) throw new SegmentPersistenceError('SEGMENT_NOT_FOUND', 'Segment not found after translation update.');
    return canonical;
  }

  async setVoiceResult(projectId: string, segmentId: string, userId: string, objectKey: string): Promise<void> {
    const prefix = `projects/${projectId}/dubbed/`;
    if (!objectKey.startsWith(prefix)) {
      throw new SegmentPersistenceError('VOICE_OBJECT_KEY_INVALID', 'Voice object key must belong to the project dubbed prefix.');
    }
    await this.db.prepare(`UPDATE segments SET dubbed_object_key = ?, voice_status = 'completed', version = version + 1
      WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)`)
      .bind(objectKey, segmentId, projectId, userId).run();
    const variants = await this.listTranslationVariants(projectId, segmentId);
    if (variants.some((variant) => variant.target_language === 'vi')) {
      await this.db.prepare(`UPDATE segment_translations
        SET dubbed_object_key = ?, voice_status = 'completed', updated_at = datetime('now')
        WHERE project_id = ? AND segment_id = ? AND target_language = 'vi'`)
        .bind(objectKey, projectId, segmentId).run();
    }
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
          translation_engine, translation_context_revision, translation_status, voice_status, dubbed_object_key, version
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'workers-ai', NULL, 'pending', 'pending', NULL, 1)`,
      ).bind(segment.id, projectId, segment.speakerId ?? null, segment.startMs, segment.endMs, segment.sourceText)),
      ...segments.map((segment) => this.db.prepare(
        `INSERT INTO segment_translations (
          segment_id, project_id, target_language, translated_text, translation_engine,
          translation_context_revision, translation_status, voice_status, dubbed_object_key, version
        ) VALUES (?, ?, 'vi', '', 'workers-ai', NULL, 'pending', 'pending', NULL, 1)`,
      ).bind(segment.id, projectId)),
      this.invalidateAllTargetExportsStatement(projectId),
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
      translationContextRevision: null,
      translationStatus: 'pending',
      voiceStatus: 'pending',
      dubbedObjectKey: null,
      version: 1,
      splitParentId: null,
    }));
  }
}
