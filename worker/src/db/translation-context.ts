import type { D1DatabaseLike } from './projects';
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

const STORAGE_ERROR_CODES = [
  'TRANSLATION_CONTEXT_CONFLICT',
  'GLOSSARY_ENTRY_CONFLICT',
  'GLOSSARY_LIMIT_REACHED',
] as const;
void STORAGE_ERROR_CODES;

export class TranslationContextRepository implements TranslationContextStore {
  constructor(private readonly db: D1DatabaseLike) {
    void this.db;
  }

  async getContext(_projectId: string, _userId: string): Promise<TranslationContext | null> {
    throw new TranslationContextPersistenceError('TRANSLATION_CONTEXT_CONFLICT', 'Translation context repository is not implemented yet.');
  }

  async updateStyle(
    _projectId: string,
    _userId: string,
    _expectedRevision: number,
    _style: TranslationStyle,
  ): Promise<TranslationContext> {
    throw new TranslationContextPersistenceError('TRANSLATION_CONTEXT_CONFLICT', 'Translation context repository is not implemented yet.');
  }

  async createEntry(
    _projectId: string,
    _userId: string,
    _expectedRevision: number,
    _input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    throw new TranslationContextPersistenceError('GLOSSARY_ENTRY_CONFLICT', 'Translation context repository is not implemented yet.');
  }

  async updateEntry(
    _projectId: string,
    _entryId: string,
    _userId: string,
    _expectedRevision: number,
    _input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    throw new TranslationContextPersistenceError('GLOSSARY_ENTRY_CONFLICT', 'Translation context repository is not implemented yet.');
  }

  async deleteEntry(
    _projectId: string,
    _entryId: string,
    _userId: string,
    _expectedRevision: number,
  ): Promise<TranslationContext> {
    throw new TranslationContextPersistenceError('GLOSSARY_LIMIT_REACHED', 'Translation context repository is not implemented yet.');
  }
}
