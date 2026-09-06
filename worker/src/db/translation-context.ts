import type { D1DatabaseLike, D1RunResultLike } from './projects';
import {
  MAX_GLOSSARY_ENTRIES,
  normalizeGlossaryInput,
  validateTranslationStyle,
  type GlossaryEntry,
  type GlossaryEntryInput,
  type NormalizedGlossaryEntryInput,
  type TranslationContext,
  type TranslationStyle,
} from '../services/translation/context';

export interface TranslationContextStore {
  getContext(projectId: string, userId: string): Promise<TranslationContext | null>;
  updateStyle(projectId: string, userId: string, expectedRevision: number, style: TranslationStyle): Promise<TranslationContext>;
  createEntry(
    projectId: string,
    userId: string,
    expectedRevision: number,
    input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }>;
  updateEntry(
    projectId: string,
    entryId: string,
    userId: string,
    expectedRevision: number,
    input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }>;
  deleteEntry(projectId: string, entryId: string, userId: string, expectedRevision: number): Promise<TranslationContext>;
}

export class TranslationContextPersistenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: TranslationContext,
  ) {
    super(message);
    this.name = 'TranslationContextPersistenceError';
  }
}

type ProjectContextRow = {
  translation_style: TranslationStyle;
  translation_context_revision: number;
};

type GlossaryRow = {
  id: string;
  project_id: string;
  source_term: string;
  preferred_translation: string;
  note: string | null;
  case_sensitive: number;
  created_at: string;
  updated_at: string;
};

function affectedRows(result: D1RunResultLike): number {
  const changes = result.meta?.changes ?? result.changes ?? 0;
  return Number.isFinite(changes) ? Math.max(0, Number(changes)) : 0;
}

function glossaryFromRow(row: GlossaryRow): GlossaryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceTerm: row.source_term,
    preferredTranslation: row.preferred_translation,
    note: row.note ?? null,
    caseSensitive: row.case_sensitive === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueGlossaryError(error: unknown): boolean {
  return error instanceof Error
    && /UNIQUE constraint failed:.*project_glossary_entries/i.test(error.message);
}

function entryMatches(entry: GlossaryEntry, input: NormalizedGlossaryEntryInput): boolean {
  return entry.sourceTerm === input.sourceTerm
    && entry.preferredTranslation === input.preferredTranslation
    && entry.note === input.note
    && entry.caseSensitive === input.caseSensitive;
}

function requireExpectedRevision(expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new TranslationContextPersistenceError(
      'TRANSLATION_CONTEXT_CONFLICT',
      'Translation context revision must be a positive integer.',
    );
  }
}

export class TranslationContextRepository implements TranslationContextStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async getContext(projectId: string, userId: string): Promise<TranslationContext | null> {
    const project = await this.db.prepare(
      `SELECT translation_style, translation_context_revision
       FROM projects
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
    ).bind(projectId, userId).first<ProjectContextRow>();
    if (!project) return null;

    const glossary = await this.db.prepare(
      `SELECT id, project_id, source_term, preferred_translation, note, case_sensitive, created_at, updated_at
       FROM project_glossary_entries
       WHERE project_id = ?
       ORDER BY source_term_key ASC, case_sensitive ASC, id ASC`,
    ).bind(projectId).all<GlossaryRow>();

    return {
      revision: Number(project.translation_context_revision),
      style: project.translation_style,
      glossary: (glossary.results ?? []).map(glossaryFromRow),
    };
  }

  async updateStyle(
    projectId: string,
    userId: string,
    expectedRevision: number,
    style: TranslationStyle,
  ): Promise<TranslationContext> {
    requireExpectedRevision(expectedRevision);
    const normalizedStyle = validateTranslationStyle(style);

    const changed = await this.db.prepare(
      `UPDATE projects
       SET translation_style = ?,
           translation_context_revision = translation_context_revision + 1,
           updated_at = datetime('now')
       WHERE id = ?
         AND user_id = ?
         AND translation_context_revision = ?
         AND translation_style <> ?`,
    ).bind(normalizedStyle, projectId, userId, expectedRevision, normalizedStyle).run();

    if (affectedRows(changed) > 0) {
      return this.requireCanonical(projectId, userId);
    }

    const noOp = await this.db.prepare(
      `UPDATE projects
       SET translation_style = translation_style
       WHERE id = ?
         AND user_id = ?
         AND translation_context_revision = ?
         AND translation_style = ?`,
    ).bind(projectId, userId, expectedRevision, normalizedStyle).run();

    if (affectedRows(noOp) > 0) {
      return this.requireCanonical(projectId, userId);
    }

    const canonical = await this.getContext(projectId, userId);
    if (!canonical) throw this.projectNotFound();
    if (canonical.revision === expectedRevision && canonical.style === normalizedStyle) return canonical;
    throw this.contextConflict(canonical);
  }

  async createEntry(
    projectId: string,
    userId: string,
    expectedRevision: number,
    input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    requireExpectedRevision(expectedRevision);
    const normalized = normalizeGlossaryInput(input);
    const id = crypto.randomUUID();

    try {
      const result = await this.db.prepare(
        `INSERT INTO project_glossary_entries (
           id, project_id, source_term, source_term_key, preferred_translation, note, case_sensitive
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM projects
           WHERE id = ? AND user_id = ? AND translation_context_revision = ?
         )
         AND (SELECT COUNT(*) FROM project_glossary_entries WHERE project_id = ?) < 200`,
      ).bind(
        id,
        projectId,
        normalized.sourceTerm,
        normalized.sourceTermKey,
        normalized.preferredTranslation,
        normalized.note,
        normalized.caseSensitive ? 1 : 0,
        projectId,
        userId,
        expectedRevision,
        projectId,
      ).run();

      if (affectedRows(result) > 0) {
        const context = await this.requireCanonical(projectId, userId);
        const entry = context.glossary.find((candidate) => candidate.id === id);
        if (!entry) {
          throw new TranslationContextPersistenceError(
            'GLOSSARY_CREATE_FAILED',
            'Glossary entry was not found after creation.',
            context,
          );
        }
        return { entry, context };
      }
    } catch (error) {
      if (!isUniqueGlossaryError(error)) throw error;
      const canonical = await this.getContext(projectId, userId);
      if (!canonical) throw this.projectNotFound();
      if (canonical.revision !== expectedRevision) throw this.contextConflict(canonical);
      throw new TranslationContextPersistenceError(
        'GLOSSARY_ENTRY_CONFLICT',
        'A glossary entry with the same canonical source term already exists.',
        canonical,
      );
    }

    const canonical = await this.getContext(projectId, userId);
    if (!canonical) throw this.projectNotFound();
    if (canonical.revision !== expectedRevision) throw this.contextConflict(canonical);
    if (canonical.glossary.length >= MAX_GLOSSARY_ENTRIES) {
      throw new TranslationContextPersistenceError(
        'GLOSSARY_LIMIT_REACHED',
        `A project can contain at most ${MAX_GLOSSARY_ENTRIES} glossary entries.`,
        canonical,
      );
    }
    throw new TranslationContextPersistenceError(
      'GLOSSARY_CREATE_FAILED',
      'Glossary entry could not be created.',
      canonical,
    );
  }

  async updateEntry(
    projectId: string,
    entryId: string,
    userId: string,
    expectedRevision: number,
    input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    requireExpectedRevision(expectedRevision);
    const normalized = normalizeGlossaryInput(input);

    try {
      const result = await this.db.prepare(
        `UPDATE project_glossary_entries
         SET source_term = ?,
             source_term_key = ?,
             preferred_translation = ?,
             note = ?,
             case_sensitive = ?,
             updated_at = datetime('now')
         WHERE id = ?
           AND project_id = ?
           AND EXISTS (
             SELECT 1 FROM projects
             WHERE id = ? AND user_id = ? AND translation_context_revision = ?
           )
           AND (
             source_term <> ?
             OR source_term_key <> ?
             OR preferred_translation <> ?
             OR note IS NOT ?
             OR case_sensitive <> ?
           )`,
      ).bind(
        normalized.sourceTerm,
        normalized.sourceTermKey,
        normalized.preferredTranslation,
        normalized.note,
        normalized.caseSensitive ? 1 : 0,
        entryId,
        projectId,
        projectId,
        userId,
        expectedRevision,
        normalized.sourceTerm,
        normalized.sourceTermKey,
        normalized.preferredTranslation,
        normalized.note,
        normalized.caseSensitive ? 1 : 0,
      ).run();

      if (affectedRows(result) > 0) {
        const context = await this.requireCanonical(projectId, userId);
        const entry = context.glossary.find((candidate) => candidate.id === entryId);
        if (!entry) {
          throw new TranslationContextPersistenceError(
            'GLOSSARY_ENTRY_NOT_FOUND',
            'Glossary entry not found.',
            context,
          );
        }
        return { entry, context };
      }
    } catch (error) {
      if (!isUniqueGlossaryError(error)) throw error;
      const canonical = await this.getContext(projectId, userId);
      if (!canonical) throw this.projectNotFound();
      if (canonical.revision !== expectedRevision) throw this.contextConflict(canonical);
      throw new TranslationContextPersistenceError(
        'GLOSSARY_ENTRY_CONFLICT',
        'A glossary entry with the same canonical source term already exists.',
        canonical,
      );
    }

    const canonical = await this.getContext(projectId, userId);
    if (!canonical) throw this.projectNotFound();
    if (canonical.revision !== expectedRevision) throw this.contextConflict(canonical);
    const entry = canonical.glossary.find((candidate) => candidate.id === entryId);
    if (!entry) {
      throw new TranslationContextPersistenceError(
        'GLOSSARY_ENTRY_NOT_FOUND',
        'Glossary entry not found.',
        canonical,
      );
    }
    if (entryMatches(entry, normalized)) return { entry, context: canonical };
    throw new TranslationContextPersistenceError(
      'GLOSSARY_UPDATE_FAILED',
      'Glossary entry could not be updated.',
      canonical,
    );
  }

  async deleteEntry(
    projectId: string,
    entryId: string,
    userId: string,
    expectedRevision: number,
  ): Promise<TranslationContext> {
    requireExpectedRevision(expectedRevision);
    const result = await this.db.prepare(
      `DELETE FROM project_glossary_entries
       WHERE id = ?
         AND project_id = ?
         AND EXISTS (
           SELECT 1 FROM projects
           WHERE id = ? AND user_id = ? AND translation_context_revision = ?
         )`,
    ).bind(entryId, projectId, projectId, userId, expectedRevision).run();

    if (affectedRows(result) > 0) return this.requireCanonical(projectId, userId);

    const canonical = await this.getContext(projectId, userId);
    if (!canonical) throw this.projectNotFound();
    if (canonical.revision !== expectedRevision) throw this.contextConflict(canonical);
    if (!canonical.glossary.some((entry) => entry.id === entryId)) {
      throw new TranslationContextPersistenceError(
        'GLOSSARY_ENTRY_NOT_FOUND',
        'Glossary entry not found.',
        canonical,
      );
    }
    throw new TranslationContextPersistenceError(
      'GLOSSARY_DELETE_FAILED',
      'Glossary entry could not be deleted.',
      canonical,
    );
  }

  private async requireCanonical(projectId: string, userId: string): Promise<TranslationContext> {
    const canonical = await this.getContext(projectId, userId);
    if (!canonical) throw this.projectNotFound();
    return canonical;
  }

  private projectNotFound(): TranslationContextPersistenceError {
    return new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
  }

  private contextConflict(context: TranslationContext): TranslationContextPersistenceError {
    return new TranslationContextPersistenceError(
      'TRANSLATION_CONTEXT_CONFLICT',
      'Translation settings changed elsewhere.',
      context,
    );
  }
}
