import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { TranslationContextRepository } from '../src/db/translation-context';
import { normalizeGlossaryInput } from '../src/services/translation/context';

type GlossaryRow = {
  id: string;
  project_id: string;
  target_language: 'vi' | 'ja';
  source_term: string;
  source_term_key: string;
  preferred_translation: string;
  note: string | null;
  case_sensitive: number;
  created_at: string;
  updated_at: string;
};

class Statement implements D1StatementLike {
  values: unknown[] = [];

  constructor(private readonly db: TargetContextDb, readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    this.db.calls.push({ sql: this.sql, values });
    return this;
  }

  async run(): Promise<D1RunResultLike> {
    return { meta: { changes: 0 } };
  }

  async first<T>() {
    if (this.sql.includes('FROM projects')) {
      return {
        translation_style: 'natural',
        translation_context_revision: 7,
      } as T;
    }
    return null;
  }

  async all<T>() {
    if (!this.sql.includes('FROM project_glossary_entries')) return { results: [] as T[] };
    const [, targetLanguage] = this.values as [string, string | undefined];
    const rows = targetLanguage
      ? this.db.rows.filter((row) => row.target_language === targetLanguage)
      : this.db.rows;
    return { results: rows.map((row) => ({ ...row })) as T[] };
  }
}

class TargetContextDb implements D1DatabaseLike {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  rows: GlossaryRow[] = [
    {
      id: 'g-vi', project_id: 'p1', target_language: 'vi', source_term: 'Bank', source_term_key: 'bank',
      preferred_translation: 'Ngân hàng', note: null, case_sensitive: 0,
      created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    },
    {
      id: 'g-ja', project_id: 'p1', target_language: 'ja', source_term: 'Bank', source_term_key: 'bank',
      preferred_translation: '銀行', note: null, case_sensitive: 0,
      created_at: '2026-09-06T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    },
  ];

  prepare(sql: string) {
    return new Statement(this, sql);
  }
}

describe('Phase 4C target-aware translation context', () => {
  it('returns only glossary rows for the requested target while keeping global style/revision', async () => {
    const db = new TargetContextDb();
    const repo = new TranslationContextRepository(db);

    await expect((repo.getContext as any)('p1', 'dev-user', 'ja')).resolves.toEqual({
      revision: 7,
      style: 'natural',
      glossary: [{
        id: 'g-ja',
        projectId: 'p1',
        targetLanguage: 'ja',
        sourceTerm: 'Bank',
        preferredTranslation: '銀行',
        note: null,
        caseSensitive: false,
        createdAt: '2026-09-06T00:00:00Z',
        updatedAt: '2026-09-06T00:00:00Z',
      }],
    });

    const glossaryRead = db.calls.find((call) => call.sql.includes('FROM project_glossary_entries'));
    expect(glossaryRead?.sql).toMatch(/target_language\s*=\s*\?/i);
    expect(glossaryRead?.values).toEqual(['p1', 'ja']);
  });

  it('normalizes an explicit target and rejects targets outside the Phase 4C set', () => {
    expect((normalizeGlossaryInput as any)({
      targetLanguage: 'ja',
      sourceTerm: 'Bank',
      preferredTranslation: '銀行',
      caseSensitive: false,
    })).toMatchObject({ targetLanguage: 'ja', sourceTerm: 'Bank', preferredTranslation: '銀行' });

    expect(() => (normalizeGlossaryInput as any)({
      targetLanguage: 'fr',
      sourceTerm: 'Bank',
      preferredTranslation: 'Banque',
      caseSensitive: false,
    })).toThrowError(expect.objectContaining({ code: 'TARGET_LANGUAGE_UNSUPPORTED' }));
  });

  it('keeps omitted legacy glossary targets pinned to Vietnamese', () => {
    expect(normalizeGlossaryInput({
      sourceTerm: 'Bank',
      preferredTranslation: 'Ngân hàng',
      caseSensitive: false,
    })).toMatchObject({ targetLanguage: 'vi' });
  });
});
