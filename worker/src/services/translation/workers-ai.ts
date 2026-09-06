import type { AiBinding } from '../../cloudflare/ai';
import { TARGET_LANGUAGES, type TargetLanguage } from '../../domain/language';
import type { SourceLanguage } from '../../domain/project';
import { isTranslationContextActive, type TranslationContext } from './context';
import { workersAISourceLanguage, workersAITargetLanguage } from './language-map';
import type { TranslationItem, TranslationProvider, TranslationResult } from './types';
import { TranslationProviderError } from './types';

export const WORKERS_AI_TRANSLATION_MODEL = '@cf/meta/m2m100-1.2b';

function translatedText(response: unknown): string {
  if (response && typeof response === 'object') {
    const value = (response as Record<string, unknown>).translated_text;
    if (typeof value === 'string') return value;
  }
  throw new TranslationProviderError('WORKERS_AI_TRANSLATION_INVALID', 'Workers AI translation response did not contain translated_text.');
}

export class WorkersAITranslationProvider implements TranslationProvider {
  readonly capabilities = { contextual: false, available: true, targets: TARGET_LANGUAGES } as const;

  constructor(private readonly ai: AiBinding) {}

  async translateBatch(
    items: TranslationItem[],
    source: SourceLanguage,
    target: TargetLanguage,
    context?: TranslationContext,
  ): Promise<TranslationResult[]> {
    if (context && isTranslationContextActive(context)) {
      throw new TranslationProviderError(
        'TRANSLATION_CONTEXT_UNSUPPORTED',
        'Raw translation provider cannot apply active project context.',
      );
    }
    const sourceLang = workersAISourceLanguage(source);
    const targetLang = workersAITargetLanguage(target);
    const results: TranslationResult[] = [];
    for (const item of items) {
      if (!item.text.trim()) {
        results.push({ id: item.id, text: '', provider: 'workers-ai' });
        continue;
      }
      const response = await this.ai.run(WORKERS_AI_TRANSLATION_MODEL, {
        text: item.text,
        source_lang: sourceLang,
        target_lang: targetLang,
      });
      results.push({ id: item.id, text: translatedText(response), provider: 'workers-ai' });
    }
    return results;
  }
}
