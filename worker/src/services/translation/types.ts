import type { SourceLanguage } from '../../domain/project';

export type TranslationItem = { id: string; text: string };
export type TranslationResult = { id: string; text: string; provider: string };

export interface TranslationProvider {
  translateBatch(items: TranslationItem[], source: SourceLanguage, target: 'vi'): Promise<TranslationResult[]>;
}

export class TranslationProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TranslationProviderError';
  }
}
