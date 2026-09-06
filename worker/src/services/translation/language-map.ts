import type { SourceLanguage } from '../../domain/project';
import type { TargetLanguage } from '../../domain/language';
import { TranslationProviderError } from './types';

const WORKERS_AI_SOURCE: Partial<Record<SourceLanguage, string>> = {
  zh: 'chinese',
  en: 'english',
  ja: 'japanese',
  ko: 'korean',
};

const WORKERS_AI_TARGET: Record<TargetLanguage, string> = {
  vi: 'vietnamese',
  en: 'english',
  zh: 'chinese',
  ja: 'japanese',
  ko: 'korean',
};

export function workersAISourceLanguage(source: SourceLanguage): string {
  const mapped = WORKERS_AI_SOURCE[source];
  if (!mapped) throw new TranslationProviderError('TRANSLATION_SOURCE_UNRESOLVED', 'Resolve auto-detected source language before translation.');
  return mapped;
}

export function workersAITargetLanguage(target: TargetLanguage): string {
  const mapped = (WORKERS_AI_TARGET as Partial<Record<string, string>>)[target];
  if (!mapped) throw new TranslationProviderError('TRANSLATION_TARGET_UNSUPPORTED', 'Unsupported translation target language.');
  return mapped;
}

export const WORKERS_AI_VIETNAMESE = WORKERS_AI_TARGET.vi;
