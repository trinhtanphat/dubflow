import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { TranslationContextRepository } from '../src/db/translation-context';
import {
  MAX_CONTEXT_PAYLOAD_BYTES,
  MAX_GLOSSARY_ENTRIES,
  TRANSLATION_STYLES,
  isTranslationContextActive,
  normalizeGlossaryKey,
  type TranslationContext,
  type TranslationStyle,
} from '../src/services/translation/context';

type ProjectContextRow = {
  id: string;
  user_id: string;
  translation_style: TranslationStyle;
  translation_context_revision: number;
};

type GlossaryRow = {
  id: string;
  project_id: string;
  source_term: string;
  source_term_key: string;
  preferred_translation: string;
  note: string | null;
  case_sensitive: number;
  created_at: string;
  updated_at: string;
};

class ContextStatement implements D1StatementLike {
  values: unknown[] = [];

  constructor(private readonly memory: ContextMemoryDb, public readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run(): Promise<D1RunResultLike> {
    if (this.sql.includes('SET translation_style = ?')) {
      const [style, projectId, userId, expectedRevision, comparisonStyle] = this.values as [
        TranslationStyle, string, string, number, TranslationStyle,
      ];
      const project = this.memory.project;
      if (project.id !== projectId || project.user_id !== userId || project.translation_context_revision !== expectedRevision) {
        return { meta: { changes: 0 } };
      }
      if (project.translation_style === comparisonStyle) return { meta: { changes: 0 } };
      project.translation_style = style;
      project.translation_context_revision += 1;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('SET translation_style = translation_style')) {
      const [projectId, userId, expectedRevision, style] = this.values as [string, string, number, TranslationStyle];
      const project = this.memory.project;
      const matches = project.id === projectId
        && project.user_id === userId
        && project.translation_context_revision === expectedRevision
        && project.translation_style === style;
      return { meta: { changes: matches ? 1 : 0 } };
    }

    if (this.sql.includes('INSERT INTO project_glossary_entries')) {
      const [
        id, projectId, sourceTerm, sourceTermKey, preferredTranslation, note, caseSensitive,
        guardedProjectId, userId, expectedRevision, countedProjectId,
      ] = this.values as [string, string, string, string, string, string | null, number, string, string, number, string];
      const project = this.memory.project;
      if (
        project.id !== projectId
        || guardedProjectId !== projectId
        || countedProjectId !== projectId
        || project.user_id !== userId
        || project.translation_context_revision !== expectedRevision
        || this.memory.glossary.filter((row) => row.project_id === projectId).length >= MAX_GLOSSARY_ENTRIES
      ) return { meta: { changes: 0 } };
      if (this.memory.glossary.some((row) =>
        row.project_id === projectId && row.source_term_key === sourceTermKey && row.case_sensitive === caseSensitive)) {
        throw new Error('UNIQUE constraint failed: project_glossary_entries.project_id, project_glossary_entries.source_term_key, project_glossary_entries.case_sensitive');
      }
      this.memory.glossary.push({
        id,
        project_id: projectId,
        source_term: sourceTerm,
        source_term_key: sourceTermKey,
        preferred_translation: preferredTranslation,
        note,
        case_sensitive: caseSensitive,
        created_at: '2026-09-06T00:00:00Z',
        updated_at: '2026-09-06T00:00:00Z',
      });
      project.translation_context_revision += 1;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('UPDATE project_glossary_entries')) {
      const [
        sourceTerm, sourceTermKey, preferredTranslation, note, caseSensitive,
        entryId, projectId, guardedProjectId, userId, expectedRevision,
      ] = this.values as [string, string, string, string | null, number, string, string, string, string, number];
      const project = this.memory.project;
      const row = this.memory.glossary.find((entry) => entry.id === entryId && entry.project_id === projectId);
      if (
        !row
        || guardedProjectId !== projectId
        || project.id !== projectId
        || project.user_id !== userId
        || project.translation_context_revision !== expectedRevision
      ) return { meta: { changes: 0 } };
      const changed = row.source_term !== sourceTerm
        || row.source_term_key !== sourceTermKey
        || row.preferred_translation !== preferredTranslation
        || row.note !== note
        || row.case_sensitive !== caseSensitive;
      if (!changed) return { meta: { changes: 0 } };
      if (this.memory.glossary.some((entry) =>
        entry.id !== entryId
        && entry.project_id === projectId
        && entry.source_term_key === sourceTermKey
        && entry.case_sensitive === caseSensitive)) {
        throw new Error('UNIQUE constraint failed: project_glossary_entries.project_id, project_glossary_entries.source_term_key, project_glossary_entries.case_sensitive');
      }
      row.source_term = sourceTerm;
      row.source_term_key = sourceTermKey;
      row.preferred_translation = preferredTranslation;
      row.note = note;
      row.case_sensitive = caseSensitive;
      row.updated_at = '2026-09-06T00:00:01Z';
      project.translation_context_revision += 1;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('DELETE FROM project_glossary_entries')) {
      const [entryId, projectId, guardedProjectId, userId, expectedRevision] = this.values as [
        string, string, string, string, number,
      ];
      const project = this.memory.project;
      const index = this.memory.glossary.findIndex((entry) => entry.id === entryId && entry.project_id === projectId);
      if (
        index < 0
        || guardedProjectId !== projectId
        || project.id !== projectId
        || project.user_id !== userId
        || project.translation_context_revision !== expectedRevision
      ) return { meta: { changes: 0 } };
      this.memory.glossary.splice(index, 1);
      project.translation_context_revision += 1;
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }

  async first<T>() {
    if (this.sql.includes('FROM projects')) {
      const [projectId, userId] = this.values as [string, string];
      const project = this.memory.project;
      if (project.id !== projectId || project.user_id !== userId) return null;
      return {
        translation_style: project.translation_style,
        translation_context_revision: project.translation_context_revision,
      } as T;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes('FROM project_glossary_entries')) {
      const [projectId] = this.values as [string];
      const rows = this.memory.glossary
        .filter((row) => row.project_id === projectId)
        .sort((left, right) => left.source_term_key.localeCompare(right.source_term_key)
          || left.case_sensitive - right.case_sensitive
          || left.id.localeCompare(right.id));
      return { results: rows.map((row) => ({ ...row })) as T[] };
    }
    return { results: [] as T[] };
  }
}

class ContextMemoryDb implements D1DatabaseLike {
  project: ProjectContextRow = {
    id: 'project-1',
    user_id: 'dev-user',
    translation_style: 'neutral',
    translation_context_revision: 1,
  };
  glossary: GlossaryRow[] = [];

  prepare(sql: string) {
    return new ContextStatement(this, sql);
  }

  seedGlossary(count: number) {
    for (let index = 0; index < count; index += 1) {
      this.glossary.push({
        id: `seed-${index}`,
        project_id: this.project.id,
        source_term: `Term ${index}`,
        source_term_key: `term ${String(index).padStart(3, '0')}`,
        preferred_translation: `Dịch ${index}`,
        note: null,
        case_sensitive: 0,
        created_at: '2026-09-06T00:00:00Z',
        updated_at: '2026-09-06T00:00:00Z',
      });
      this.project.translation_context_revision += 1;
    }
  }
}

describe('Phase 4A translation context primitives', () => {
  it('normalizes glossary keys deterministically', () => {
    expect(normalizeGlossaryKey('  Ａcme  ', false)).toBe('acme');
    expect(normalizeGlossaryKey('  Ａcme  ', true)).toBe('Acme');
  });

  it('locks the canonical styles and context limits', () => {
    expect(TRANSLATION_STYLES).toEqual(['neutral', 'natural', 'formal', 'casual', 'cinematic']);
    expect(MAX_GLOSSARY_ENTRIES).toBe(200);
    expect(MAX_CONTEXT_PAYLOAD_BYTES).toBe(128 * 1024);
  });

  it('treats neutral empty context as inactive and style/glossary context as active', () => {
    const neutral: TranslationContext = { revision: 1, style: 'neutral', glossary: [] };
    expect(isTranslationContextActive(neutral)).toBe(false);
    expect(isTranslationContextActive({ ...neutral, style: 'formal' })).toBe(true);
    expect(isTranslationContextActive({
      ...neutral,
      glossary: [{
        id: 'g1', projectId: 'p1', targetLanguage: 'vi', sourceTerm: 'Acme', preferredTranslation: 'Acme', note: null,
        caseSensitive: false, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
      }],
    })).toBe(true);
  });
});

describe('TranslationContextRepository style revision behavior', () => {
  it('reads the canonical default context for an owned project', async () => {
    const repo = new TranslationContextRepository(new ContextMemoryDb());
    await expect(repo.getContext('project-1', 'dev-user')).resolves.toEqual({
      revision: 1,
      style: 'neutral',
      glossary: [],
    });
  });

  it('increments the context revision exactly once for a real style change', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    await expect(repo.updateStyle('project-1', 'dev-user', 1, 'formal')).resolves.toEqual({
      revision: 2,
      style: 'formal',
      glossary: [],
    });
    expect(memory.project.translation_context_revision).toBe(2);
  });

  it('keeps the revision unchanged for an idempotent same-style update', async () => {
    const memory = new ContextMemoryDb();
    memory.project.translation_style = 'natural';
    memory.project.translation_context_revision = 2;
    const repo = new TranslationContextRepository(memory);
    await expect(repo.updateStyle('project-1', 'dev-user', 2, 'natural')).resolves.toEqual({
      revision: 2,
      style: 'natural',
      glossary: [],
    });
    expect(memory.project.translation_context_revision).toBe(2);
  });

  it('returns the canonical context on stale revision without incrementing', async () => {
    const memory = new ContextMemoryDb();
    memory.project.translation_style = 'cinematic';
    memory.project.translation_context_revision = 4;
    const repo = new TranslationContextRepository(memory);
    await expect(repo.updateStyle('project-1', 'dev-user', 3, 'formal')).rejects.toMatchObject({
      code: 'TRANSLATION_CONTEXT_CONFLICT',
      context: { revision: 4, style: 'cinematic', glossary: [] },
    });
    expect(memory.project.translation_context_revision).toBe(4);
  });

  it('rejects an invalid style without mutating revision', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    await expect(repo.updateStyle('project-1', 'dev-user', 1, 'brand' as TranslationStyle))
      .rejects.toMatchObject({ code: 'TRANSLATION_STYLE_INVALID' });
    expect(memory.project.translation_context_revision).toBe(1);
  });
});

describe('TranslationContextRepository glossary mutations', () => {
  it('creates a normalized glossary entry and increments revision once', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    const result = await repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: '  Acme  ',
      preferredTranslation: '  Acme Việt Nam  ',
      note: '   ',
      caseSensitive: false,
    });
    expect(result.context.revision).toBe(2);
    expect(result.entry).toMatchObject({
      sourceTerm: 'Acme',
      preferredTranslation: 'Acme Việt Nam',
      note: null,
      caseSensitive: false,
    });
    expect(memory.project.translation_context_revision).toBe(2);
  });

  it('rejects canonical duplicates without incrementing revision', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    await repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'Acme', preferredTranslation: 'Acme', note: null, caseSensitive: false,
    });
    await expect(repo.createEntry('project-1', 'dev-user', 2, {
      sourceTerm: 'ＡCME', preferredTranslation: 'Acme khác', note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'GLOSSARY_ENTRY_CONFLICT' });
    expect(memory.project.translation_context_revision).toBe(2);
    expect(memory.glossary).toHaveLength(1);
  });

  it('enforces the 200-entry project limit without incrementing revision', async () => {
    const memory = new ContextMemoryDb();
    memory.seedGlossary(200);
    const revision = memory.project.translation_context_revision;
    const repo = new TranslationContextRepository(memory);
    await expect(repo.createEntry('project-1', 'dev-user', revision, {
      sourceTerm: 'Overflow', preferredTranslation: 'Tràn', note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'GLOSSARY_LIMIT_REACHED' });
    expect(memory.project.translation_context_revision).toBe(revision);
    expect(memory.glossary).toHaveLength(200);
  });

  it('increments once for a real update and keeps revision stable for an idempotent update', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    const created = await repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'OpenAI', preferredTranslation: 'OpenAI', note: null, caseSensitive: true,
    });
    const updated = await repo.updateEntry('project-1', created.entry.id, 'dev-user', 2, {
      sourceTerm: 'OpenAI', preferredTranslation: 'OpenAI Việt Nam', note: 'Tên riêng', caseSensitive: true,
    });
    expect(updated.context.revision).toBe(3);
    expect(updated.entry.preferredTranslation).toBe('OpenAI Việt Nam');
    const noOp = await repo.updateEntry('project-1', created.entry.id, 'dev-user', 3, {
      sourceTerm: 'OpenAI', preferredTranslation: 'OpenAI Việt Nam', note: 'Tên riêng', caseSensitive: true,
    });
    expect(noOp.context.revision).toBe(3);
    expect(memory.project.translation_context_revision).toBe(3);
  });

  it('deletes an owned entry once and reports a missing entry without another increment', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    const created = await repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'Brand', preferredTranslation: 'Thương hiệu', note: null, caseSensitive: false,
    });
    const deleted = await repo.deleteEntry('project-1', created.entry.id, 'dev-user', 2);
    expect(deleted.revision).toBe(3);
    expect(deleted.glossary).toEqual([]);
    await expect(repo.deleteEntry('project-1', created.entry.id, 'dev-user', 3))
      .rejects.toMatchObject({ code: 'GLOSSARY_ENTRY_NOT_FOUND' });
    expect(memory.project.translation_context_revision).toBe(3);
  });

  it('returns canonical context for stale glossary mutations and hides cross-user projects', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    await repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'Acme', preferredTranslation: 'Acme', note: null, caseSensitive: false,
    });
    await expect(repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'Other', preferredTranslation: 'Khác', note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'TRANSLATION_CONTEXT_CONFLICT', context: { revision: 2 } });
    await expect(repo.createEntry('project-1', 'other-user', 2, {
      sourceTerm: 'Other', preferredTranslation: 'Khác', note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(repo.getContext('project-1', 'other-user')).resolves.toBeNull();
    expect(memory.project.translation_context_revision).toBe(2);
  });

  it('validates Unicode lengths and required glossary fields before writing', async () => {
    const memory = new ContextMemoryDb();
    const repo = new TranslationContextRepository(memory);
    await expect(repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: '   ', preferredTranslation: 'x', note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'GLOSSARY_SOURCE_TERM_INVALID' });
    await expect(repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'x', preferredTranslation: '   ', note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'GLOSSARY_TRANSLATION_INVALID' });
    await expect(repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: '😀'.repeat(121), preferredTranslation: 'x', note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'GLOSSARY_SOURCE_TERM_INVALID' });
    await expect(repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'x', preferredTranslation: '😀'.repeat(201), note: null, caseSensitive: false,
    })).rejects.toMatchObject({ code: 'GLOSSARY_TRANSLATION_INVALID' });
    await expect(repo.createEntry('project-1', 'dev-user', 1, {
      sourceTerm: 'x', preferredTranslation: 'y', note: '😀'.repeat(301), caseSensitive: false,
    })).rejects.toMatchObject({ code: 'GLOSSARY_NOTE_INVALID' });
    expect(memory.project.translation_context_revision).toBe(1);
    expect(memory.glossary).toEqual([]);
  });
});