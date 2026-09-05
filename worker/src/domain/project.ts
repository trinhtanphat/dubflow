export const SOURCE_LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko'] as const;
export const TARGET_LANGUAGE = 'vi' as const;

export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];
export type TargetLanguage = typeof TARGET_LANGUAGE;

export type CreateProjectInput = {
  title: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
};

export class ProjectInputError extends Error {
  readonly code = 'INVALID_PROJECT_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectInputError';
  }
}

function isSourceLanguage(value: unknown): value is SourceLanguage {
  return typeof value === 'string' && (SOURCE_LANGUAGES as readonly string[]).includes(value);
}

export function normalizeProjectInput(input: unknown): CreateProjectInput {
  if (!input || typeof input !== 'object') {
    throw new ProjectInputError('Project input must be an object.');
  }

  const record = input as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) {
    throw new ProjectInputError('Project title is required.');
  }

  if (!isSourceLanguage(record.sourceLanguage)) {
    throw new ProjectInputError('Unsupported source language.');
  }

  const targetLanguage = record.targetLanguage ?? TARGET_LANGUAGE;
  if (targetLanguage !== TARGET_LANGUAGE) {
    throw new ProjectInputError('Vietnamese is the only Phase 1 target language.');
  }

  return {
    title,
    sourceLanguage: record.sourceLanguage,
    targetLanguage: TARGET_LANGUAGE,
  };
}
