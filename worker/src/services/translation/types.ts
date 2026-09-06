import type { SourceLanguage } from '../../domain/project';
import type { TargetLanguage } from '../../domain/language';
import type { TranslationContext } from './context';

export type TranslationItem = { id: string; text: string };
export type TranslationResult = { id: string; text: string; provider: string };

export type TranslationProviderCapabilities = {
  contextual: boolean;
  available: boolean;
  targets: readonly TargetLanguage[];
};

export interface TranslationProvider {
  readonly capabilities: TranslationProviderCapabilities;
  translateBatch(
    items: TranslationItem[],
    source: SourceLanguage,
    target: TargetLanguage,
    context?: TranslationContext,
  ): Promise<TranslationResult[]>;
}

export class TranslationProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TranslationProviderError';
  }
}
