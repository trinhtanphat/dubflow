import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { SegmentTranslationRepository } from '../src/db/segment-translations';
import type { TargetLanguage } from '../src/domain/language';

type Row = {
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

class TranslationMemoryDb implements D1DatabaseLike {
  readonly project = { id: 'p1', user_id: 'u1' };
  readonly rows = new Map<TargetLanguage, Row>([
    ['vi', { segment_id: 's1', project_id: 'p1', target_language: 'vi', translated_text: 'cũ', translation_engine: 'workers-ai', translation_status: 'completed', translation_context_revision: 1, voice_status: 'completed', dubbed_object_key: 'projects/p1/voices/vi/s1/2.mp3', version: 2 }],
    ['ja', { segment_id: 's1', project_id: 'p1', target_language: 'ja', translated_text: '古い', translation_engine: 'workers-ai', translation_status: 'completed', translation_context_revision: 1, voice_status: 'completed', dubbed_object_key: 'projects/p1/voices/ja/s1/2.mp3', version: 2 }],
  ]);
  legacy = { translated_text: 'cũ', voice_status: 'completed', dubbed_object_key: 'projects/p1/dubbed/s1.mp3' as string | null };
  invalidatedTargets: TargetLanguage[] = [];
  invalidatedAll = false;

  prepare(sql: string): D1StatementLike { return new TranslationStatement(this, sql); }
  async batch(statements: D1StatementLike[]) {
    const results: D1RunResultLike[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class TranslationStatement implements D1StatementLike {
  private values: unknown[] = [];
  constructor(private readonly db: TranslationMemoryDb, private readonly sql: string) {}
  bind(...values: unknown[]): D1StatementLike { this.values = values; return this; }

  async run(): Promise<D1RunResultLike> {
    if (/UPDATE segment_translations[\s\S]*translated_text = \?/i.test(this.sql)) {
      const [text, segmentId, projectId, target, userId, expectedVersion] = this.values as [string, string, string, TargetLanguage, string, number];
      const row = this.db.rows.get(target);
      if (!row || row.segment_id !== segmentId || row.project_id !== projectId || userId !== this.db.project.user_id || row.version !== expectedVersion) {
        return { meta: { changes: 0 } };
      }
      row.translated_text = text;
      row.translation_status = 'completed';
      row.voice_status = 'pending';
      row.dubbed_object_key = null;
      row.version += 1;
      return { meta: { changes: 1 } };
    }
    if (/INSERT INTO segment_translations/i.test(this.sql)) {
      const [segmentId, projectId, target, text, engine, contextRevision] = this.values as [string, string, TargetLanguage, string, string, number | null];
      const current = this.db.rows.get(target);
      if (current?.translation_status === 'completed') return { meta: { changes: 0 } };
      this.db.rows.set(target, {
        segment_id: segmentId, project_id: projectId, target_language: target, translated_text: text,
        translation_engine: engine, translation_status: 'completed', translation_context_revision: contextRevision,
        voice_status: 'pending', dubbed_object_key: null, version: (current?.version ?? 0) + 1,
      });
      return { meta: { changes: 1 } };
    }
    if (/UPDATE segments[\s\S]*translated_text = \?/i.test(this.sql)) {
      const [text] = this.values as [string];
      this.db.legacy.translated_text = text;
      this.db.legacy.voice_status = 'pending';
      this.db.legacy.dubbed_object_key = null;
      return { meta: { changes: 1 } };
    }
    if (/UPDATE project_exports[\s\S]*target_language = \?/i.test(this.sql)) {
      const target = this.values.find((value) => value === 'vi' || value === 'en' || value === 'zh' || value === 'ja' || value === 'ko') as TargetLanguage;
      this.db.invalidatedTargets.push(target);
      return { meta: { changes: 1 } };
    }
    if (/UPDATE segment_translations[\s\S]*translation_status = 'pending'/i.test(this.sql)) {
      for (const row of this.db.rows.values()) {
        row.translation_status = 'pending'; row.voice_status = 'pending'; row.dubbed_object_key = null; row.version += 1;
      }
      return { meta: { changes: this.db.rows.size } };
    }
    if (/UPDATE project_exports[\s\S]*status = 'invalidated'/i.test(this.sql)) {
      this.db.invalidatedAll = true;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  async first<T>(): Promise<T | null> {
    if (/FROM segment_translations st[\s\S]*JOIN projects p/i.test(this.sql)) {
      const [projectId, segmentId, target, userId] = this.values as [string, string, TargetLanguage, string];
      if (projectId !== this.db.project.id || userId !== this.db.project.user_id) return null;
      const row = this.db.rows.get(target);
      return row && row.segment_id === segmentId ? ({ ...row } as T) : null;
    }
    if (/SELECT id FROM projects/i.test(this.sql)) {
      const [projectId, userId] = this.values as [string, string];
      return projectId === this.db.project.id && userId === this.db.project.user_id ? ({ id: projectId } as T) : null;
    }
    return null;
  }

  async all<T>(): Promise<{ results?: T[] }> {
    if (/FROM segment_translations st[\s\S]*JOIN projects p/i.test(this.sql)) {
      const [projectId, target, userId] = this.values as [string, TargetLanguage, string];
      if (projectId !== this.db.project.id || userId !== this.db.project.user_id) return { results: [] };
      return { results: [...this.db.rows.values()].filter((row) => row.target_language === target).map((row) => ({ ...row })) as T[] };
    }
    return { results: [] };
  }
}

describe('segment translation repository', () => {
  it('increments only the edited target version and invalidates target TTS/export state', async () => {
    const db = new TranslationMemoryDb();
    const repo = new SegmentTranslationRepository(db);
    const updated = await repo.updateText('p1', 's1', 'u1', 'ja', 2, '新しい訳');
    expect(updated.version).toBe(3);
    expect((await repo.get('p1', 's1', 'u1', 'vi'))?.version).toBe(2);
    expect(updated.voiceStatus).toBe('pending');
    expect(updated.dubbedObjectKey).toBeNull();
    expect(db.invalidatedTargets).toContain('ja');
  });

  it('mirrors Vietnamese edits to legacy segment fields', async () => {
    const db = new TranslationMemoryDb();
    const repo = new SegmentTranslationRepository(db);
    await repo.updateText('p1', 's1', 'u1', 'vi', 2, 'bản mới');
    expect(db.legacy).toEqual({ translated_text: 'bản mới', voice_status: 'pending', dubbed_object_key: null });
  });

  it('stores provider context revision and source invalidation clears all target voice state', async () => {
    const db = new TranslationMemoryDb();
    db.rows.get('ja')!.translation_status = 'pending';
    const repo = new SegmentTranslationRepository(db);
    const translated = await repo.setTranslationResult('p1', 's1', 'u1', 'ja', '翻訳', 'google', 7);
    expect(translated.translationContextRevision).toBe(7);

    await repo.invalidateForSourceSegment('p1', 's1', 'u1');
    expect([...db.rows.values()].every((row) => row.translation_status === 'pending' && row.voice_status === 'pending' && row.dubbed_object_key === null)).toBe(true);
    expect(db.invalidatedAll).toBe(true);
  });
});
