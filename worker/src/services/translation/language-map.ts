import type { SourceLanguage } from '../../domain/project';
import { TranslationProviderError } from './types';

const WORKERS_AI_SOURCE: Partial<Record<SourceLanguage, string>> = {
  zh: 'chinese',
  en: 'english',
  ja: 'japanese',
  ko: 'korean',
};

export function workersAISourceLanguage(source: SourceLanguage): string {
  const mapped = WORKERS_AI_SOURCE[source];
  if (!mapped) throw new TranslationProviderError('TRANSLATION_SOURCE_UNRESOLVED', 'Resolve auto-detected source language before translation.');
  return mapped;
}

export const WORKERS_AI_VIETNAMESE = 'vietnamese';
