import type { AiBinding } from '../../cloudflare/ai';
import type { SourceLanguage } from '../../domain/project';
import { workersAISourceLanguage, WORKERS_AI_VIETNAMESE } from './language-map';
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
  constructor(private readonly ai: AiBinding) {}

  async translateBatch(items: TranslationItem[], source: SourceLanguage, target: 'vi'): Promise<TranslationResult[]> {
    if (target !== 'vi') throw new TranslationProviderError('TRANSLATION_TARGET_UNSUPPORTED', 'Vietnamese is the only supported target.');
    const sourceLang = workersAISourceLanguage(source);
    const results: TranslationResult[] = [];
    for (const item of items) {
      if (!item.text.trim()) {
        results.push({ id: item.id, text: '', provider: 'workers-ai' });
        continue;
      }
      const response = await this.ai.run(WORKERS_AI_TRANSLATION_MODEL, {
        text: item.text,
        source_lang: sourceLang,
        target_lang: WORKERS_AI_VIETNAMESE,
      });
      results.push({ id: item.id, text: translatedText(response), provider: 'workers-ai' });
    }
    return results;
  }
}
