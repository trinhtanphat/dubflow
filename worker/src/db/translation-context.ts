import type { D1DatabaseLike, D1RunResultLike } from './projects';
import type {
  GlossaryEntry,
  GlossaryEntryInput,
  TranslationContext,
  TranslationStyle,
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
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new TranslationContextPersistenceError(
        'TRANSLATION_CONTEXT_CONFLICT',
        'Translation context revision must be a positive integer.',
      );
    }

    const changed = await this.db.prepare(
      `UPDATE projects
       SET translation_style = ?,
           translation_context_revision = translation_context_revision + 1,
           updated_at = datetime('now')
       WHERE id = ?
         AND user_id = ?
         AND translation_context_revision = ?
         AND translation_style <> ?`,
    ).bind(style, projectId, userId, expectedRevision, style).run();

    if (affectedRows(changed) > 0) {
      const canonical = await this.getContext(projectId, userId);
      if (!canonical) {
        throw new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
      }
      return canonical;
    }

    const noOp = await this.db.prepare(
      `UPDATE projects
       SET translation_style = translation_style
       WHERE id = ?
         AND user_id = ?
         AND translation_context_revision = ?
         AND translation_style = ?`,
    ).bind(projectId, userId, expectedRevision, style).run();

    if (affectedRows(noOp) > 0) {
      const canonical = await this.getContext(projectId, userId);
      if (!canonical) {
        throw new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
      }
      return canonical;
    }

    const canonical = await this.getContext(projectId, userId);
    if (!canonical) {
      throw new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    }
    if (canonical.revision === expectedRevision && canonical.style === style) return canonical;
    throw new TranslationContextPersistenceError(
      'TRANSLATION_CONTEXT_CONFLICT',
      'Translation settings changed elsewhere.',
      canonical,
    );
  }

  async createEntry(
    _projectId: string,
    _userId: string,
    _expectedRevision: number,
    _input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    throw new TranslationContextPersistenceError('GLOSSARY_ENTRY_CONFLICT', 'Glossary create is not implemented yet.');
  }

  async updateEntry(
    _projectId: string,
    _entryId: string,
    _userId: string,
    _expectedRevision: number,
    _input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    throw new TranslationContextPersistenceError('GLOSSARY_ENTRY_CONFLICT', 'Glossary update is not implemented yet.');
  }

  async deleteEntry(
    _projectId: string,
    _entryId: string,
    _userId: string,
    _expectedRevision: number,
  ): Promise<TranslationContext> {
    throw new TranslationContextPersistenceError('GLOSSARY_LIMIT_REACHED', 'Glossary delete is not implemented yet.');
  }
}
