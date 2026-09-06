export const SUPPORTED_TARGET_LANGUAGES = ['vi', 'en', 'ja', 'ko', 'zh'] as const;

export type TargetLanguage = (typeof SUPPORTED_TARGET_LANGUAGES)[number];

export const MAX_BATCH_TARGET_LANGUAGES = 4;

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && (SUPPORTED_TARGET_LANGUAGES as readonly string[]).includes(value);
}

export function parseTargetLanguage(value: unknown, fallback: TargetLanguage = 'vi'): TargetLanguage {
  if (value === undefined || value === null || value === '') return fallback;
  if (!isTargetLanguage(value)) throw new Error('Unsupported target language.');
  return value;
}

export function parseBatchTargetLanguages(value: unknown): TargetLanguage[] {
  if (!Array.isArray(value)) throw new Error('targetLanguages must be an array.');
  const result: TargetLanguage[] = [];
  for (const raw of value) {
    const target = parseTargetLanguage(raw);
    if (!result.includes(target)) result.push(target);
  }
  if (result.length === 0) throw new Error('At least one target language is required.');
  if (result.length > MAX_BATCH_TARGET_LANGUAGES) throw new Error(`Select at most ${MAX_BATCH_TARGET_LANGUAGES} target languages.`);
  return result;
}
