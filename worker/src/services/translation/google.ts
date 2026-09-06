import type { SourceLanguage } from '../../domain/project';
import type { TargetLanguage } from '../../domain/target-language';
import { isTranslationContextActive, type TranslationContext } from './context';
import type { TranslationItem, TranslationProvider, TranslationResult } from './types';
import { TranslationProviderError } from './types';

const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const GOOGLE_SOURCE: Partial<Record<SourceLanguage, string>> = {
  zh: 'zh', en: 'en', ja: 'ja', ko: 'ko',
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export class GoogleCloudTranslationProvider implements TranslationProvider {
  readonly capabilities: { contextual: false; available: boolean };

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    this.capabilities = { contextual: false, available: Boolean(apiKey.trim()) };
  }

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
    if (!this.apiKey.trim()) {
      throw new TranslationProviderError('GOOGLE_TRANSLATE_SECRET_MISSING', 'Google Cloud Translation API key is not configured.');
    }
    const sourceCode = GOOGLE_SOURCE[source];
    if (!sourceCode) throw new TranslationProviderError('TRANSLATION_SOURCE_UNRESOLVED', 'Resolve auto-detected source language before translation.');

    const nonEmpty = items.filter((item) => item.text.trim());
    if (nonEmpty.length === 0) return items.map((item) => ({ id: item.id, text: '', provider: 'google' }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${GOOGLE_ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: nonEmpty.map((item) => item.text), source: sourceCode, target, format: 'text' }),
        signal: controller.signal,
      });
    } catch (error) {
      const code = error instanceof DOMException && error.name === 'AbortError' ? 'GOOGLE_TRANSLATE_TIMEOUT' : 'GOOGLE_TRANSLATE_NETWORK';
      throw new TranslationProviderError(code, 'Google Cloud Translation request failed.');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new TranslationProviderError('GOOGLE_TRANSLATE_HTTP', `Google Cloud Translation returned HTTP ${response.status}.`);
    const payload = await response.json() as { data?: { translations?: { translatedText?: string }[] } };
    const translations = payload.data?.translations ?? [];
    if (translations.length !== nonEmpty.length) {
      throw new TranslationProviderError('GOOGLE_TRANSLATE_INVALID', 'Google Cloud Translation returned an unexpected result count.');
    }

    let translatedIndex = 0;
    return items.map((item) => {
      if (!item.text.trim()) return { id: item.id, text: '', provider: 'google' };
      const text = translations[translatedIndex++]?.translatedText;
      if (typeof text !== 'string') throw new TranslationProviderError('GOOGLE_TRANSLATE_INVALID', 'Google translation result was missing text.');
      return { id: item.id, text: decodeHtmlEntities(text), provider: 'google' };
    });
  }
}
