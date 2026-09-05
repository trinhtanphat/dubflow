import type { SourceLanguage } from '../../domain/project';
import type { TranslationItem, TranslationProvider } from './types';
import { TranslationProviderError } from './types';

export type TranslationMode = 'workers-ai' | 'google' | 'compare';

export class TranslationRouter {
  constructor(
    private readonly workersAI: TranslationProvider,
    private readonly google: TranslationProvider,
  ) {}

  async translate(mode: TranslationMode, items: TranslationItem[], source: SourceLanguage, target: 'vi') {
    if (mode === 'workers-ai') return { mode, primary: await this.workersAI.translateBatch(items, source, target) } as const;
    if (mode === 'google') return { mode, primary: await this.google.translateBatch(items, source, target) } as const;
    if (mode === 'compare') {
      const [workersAI, google] = await Promise.all([
        this.workersAI.translateBatch(items, source, target),
        this.google.translateBatch(items, source, target),
      ]);
      return { mode, workersAI, google } as const;
    }
    throw new TranslationProviderError('TRANSLATION_MODE_INVALID', 'Unknown translation mode.');
  }
}
