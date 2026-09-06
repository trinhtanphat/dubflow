export const TARGET_LANGUAGES = ['vi', 'en', 'zh', 'ja', 'ko'] as const;

export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

export const TARGET_LANGUAGE_LABELS: Record<TargetLanguage, string> = {
  vi: 'Vietnamese',
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
};

export type ExportOutput = 'dubbed' | 'subtitles';

export type ProjectLanguageStatus =
  | 'pending'
  | 'translating'
  | 'needs_review'
  | 'ready'
  | 'exporting'
  | 'completed'
  | 'failed';

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string'
    && (TARGET_LANGUAGES as readonly string[]).includes(value);
}
