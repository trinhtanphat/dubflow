import { isTargetLanguage, type TargetLanguage } from '../../domain/language';

export const TRANSLATION_STYLES = ['neutral', 'natural', 'formal', 'casual', 'cinematic'] as const;
export type TranslationStyle = typeof TRANSLATION_STYLES[number];

export const MAX_GLOSSARY_ENTRIES = 200;
export const MAX_SOURCE_TERM_CHARS = 120;
export const MAX_PREFERRED_TRANSLATION_CHARS = 200;
export const MAX_GLOSSARY_NOTE_CHARS = 300;
export const MAX_CONTEXT_PAYLOAD_BYTES = 128 * 1024;

export type GlossaryEntry = {
  id: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  sourceTerm: string;
  preferredTranslation: string;
  note: string | null;
  caseSensitive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GlossaryEntryInput = {
  targetLanguage?: TargetLanguage;
  sourceTerm: string;
  preferredTranslation: string;
  note?: string | null;
  caseSensitive: boolean;
};

export type NormalizedGlossaryEntryInput = {
  targetLanguage: TargetLanguage;
  sourceTerm: string;
  sourceTermKey: string;
  preferredTranslation: string;
  note: string | null;
  caseSensitive: boolean;
};

export type TranslationContext = {
  revision: number;
  style: TranslationStyle;
  glossary: GlossaryEntry[];
};

export class TranslationContextValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TranslationContextValidationError';
  }
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function validateTranslationStyle(value: unknown): TranslationStyle {
  if (typeof value !== 'string' || !TRANSLATION_STYLES.includes(value as TranslationStyle)) {
    throw new TranslationContextValidationError(
      'TRANSLATION_STYLE_INVALID',
      'Translation style is invalid.',
    );
  }
  return value as TranslationStyle;
}

export function normalizeGlossaryKey(value: string, caseSensitive: boolean): string {
  const normalized = value.trim().normalize('NFKC');
  return caseSensitive ? normalized : normalized.toLowerCase();
}

export function normalizeGlossaryInput(input: GlossaryEntryInput): NormalizedGlossaryEntryInput {
  if (!input || typeof input !== 'object') {
    throw new TranslationContextValidationError('GLOSSARY_SOURCE_TERM_INVALID', 'Glossary entry is invalid.');
  }

  const targetLanguage = input.targetLanguage ?? 'vi';
  if (!isTargetLanguage(targetLanguage)) {
    throw new TranslationContextValidationError(
      'TARGET_LANGUAGE_UNSUPPORTED',
      'Target language is not supported.',
    );
  }

  if (typeof input.caseSensitive !== 'boolean') {
    throw new TranslationContextValidationError(
      'GLOSSARY_CASE_SENSITIVE_INVALID',
      'Glossary case-sensitive flag must be a boolean.',
    );
  }

  if (typeof input.sourceTerm !== 'string') {
    throw new TranslationContextValidationError(
      'GLOSSARY_SOURCE_TERM_INVALID',
      'Glossary source term is required.',
    );
  }
  const sourceTerm = input.sourceTerm.trim();
  if (!sourceTerm || unicodeLength(sourceTerm) > MAX_SOURCE_TERM_CHARS) {
    throw new TranslationContextValidationError(
      'GLOSSARY_SOURCE_TERM_INVALID',
      `Glossary source term must contain 1-${MAX_SOURCE_TERM_CHARS} Unicode characters.`,
    );
  }

  if (typeof input.preferredTranslation !== 'string') {
    throw new TranslationContextValidationError(
      'GLOSSARY_TRANSLATION_INVALID',
      'Preferred glossary translation is required.',
    );
  }
  const preferredTranslation = input.preferredTranslation.trim();
  if (!preferredTranslation || unicodeLength(preferredTranslation) > MAX_PREFERRED_TRANSLATION_CHARS) {
    throw new TranslationContextValidationError(
      'GLOSSARY_TRANSLATION_INVALID',
      `Preferred glossary translation must contain 1-${MAX_PREFERRED_TRANSLATION_CHARS} Unicode characters.`,
    );
  }

  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    throw new TranslationContextValidationError(
      'GLOSSARY_NOTE_INVALID',
      'Glossary note must be text when provided.',
    );
  }
  const trimmedNote = typeof input.note === 'string' ? input.note.trim() : '';
  if (unicodeLength(trimmedNote) > MAX_GLOSSARY_NOTE_CHARS) {
    throw new TranslationContextValidationError(
      'GLOSSARY_NOTE_INVALID',
      `Glossary note must contain at most ${MAX_GLOSSARY_NOTE_CHARS} Unicode characters.`,
    );
  }
  const note = trimmedNote || null;

  return {
    targetLanguage,
    sourceTerm,
    sourceTermKey: normalizeGlossaryKey(sourceTerm, input.caseSensitive),
    preferredTranslation,
    note,
    caseSensitive: input.caseSensitive,
  };
}

export function isTranslationContextActive(context: TranslationContext): boolean {
  return context.style !== 'neutral' || context.glossary.length > 0;
}
