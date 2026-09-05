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
    if (this.sql.includes('FROM project_glossary_entries')) return { results: [] as T[] };
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

  prepare(sql: string) {
    return new ContextStatement(this, sql);
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
        id: 'g1', projectId: 'p1', sourceTerm: 'Acme', preferredTranslation: 'Acme', note: null,
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
});
