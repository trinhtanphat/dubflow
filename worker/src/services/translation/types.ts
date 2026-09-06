import type { SourceLanguage } from '../../domain/project';
import type { TranslationContext } from './context';

export type TranslationItem = { id: string; text: string };
export type TranslationResult = { id: string; text: string; provider: string };

export type TranslationProviderCapabilities = {
  contextual: boolean;
  available: boolean;
};

export interface TranslationProvider {
  readonly capabilities: TranslationProviderCapabilities;
  translateBatch(
    items: TranslationItem[],
    source: SourceLanguage,
    target: 'vi',
    context?: TranslationContext,
  ): Promise<TranslationResult[]>;
}

export class TranslationProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TranslationProviderError';
  }
}
