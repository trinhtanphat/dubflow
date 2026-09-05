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
  sourceTerm: string;
  preferredTranslation: string;
  note: string | null;
  caseSensitive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GlossaryEntryInput = {
  sourceTerm: string;
  preferredTranslation: string;
  note?: string | null;
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

export function normalizeGlossaryKey(value: string, caseSensitive: boolean): string {
  const normalized = value.trim().normalize('NFKC');
  return caseSensitive ? normalized : normalized.toLowerCase();
}

export function isTranslationContextActive(context: TranslationContext): boolean {
  return context.style !== 'neutral' || context.glossary.length > 0;
}
