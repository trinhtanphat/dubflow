import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { TARGET_LANGUAGES, type TargetLanguage } from '../src/domain/language';
import { ContextualWorkersAITranslationProvider } from '../src/services/translation/contextual';
import { GoogleCloudTranslationProvider } from '../src/services/translation/google';
import { TranslationRouter } from '../src/services/translation/router';
import { TranslationProviderError } from '../src/services/translation/types';
import { WorkersAITranslationProvider } from '../src/services/translation/workers-ai';

class RecordingAI implements AiBinding {
  calls: Array<{ model: string; input: any }> = [];

  async run(model: string, input: unknown): Promise<unknown> {
    this.calls.push({ model, input });
    if (input && typeof input === 'object' && Array.isArray((input as any).messages)) {
      return { response: JSON.stringify({ translations: [{ id: 'a', text: 'translated' }] }) };
    }
    return { translated_text: 'translated' };
  }
}

const context = {
  revision: 9,
  style: 'natural' as const,
  glossary: [],
};

class StubProvider {
  readonly capabilities: { contextual: boolean; available: boolean; targets: readonly TargetLanguage[] };
  readonly calls: string[] = [];

  constructor(
    private readonly name: string,
    targets: readonly TargetLanguage[] = TARGET_LANGUAGES,
    contextual = false,
    available = true,
  ) {
    this.capabilities = { contextual, available, targets };
  }

  async translateBatch(items: Array<{ id: string; text: string }>, _source: string, target: string) {
    this.calls.push(target);
    return items.map((item) => ({ id: item.id, text: `${this.name}:${target}:${item.text}`, provider: this.name }));
  }
}

describe('Phase 4C translation provider target contract', () => {
  it('advertises the exact five target languages on every configured provider', () => {
    const ai = new RecordingAI();
    expect(new WorkersAITranslationProvider(ai).capabilities).toEqual({
      contextual: false,
      available: true,
      targets: TARGET_LANGUAGES,
    });
    expect(new GoogleCloudTranslationProvider('key').capabilities).toEqual({
      contextual: false,
      available: true,
      targets: TARGET_LANGUAGES,
    });
    expect(new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model').capabilities).toEqual({
      contextual: true,
      available: true,
      targets: TARGET_LANGUAGES,
    });
  });

  it('sends the requested Google target language instead of hard-coding Vietnamese', async () => {
    let requestBody: any;
    const provider = new GoogleCloudTranslationProvider('key', async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ data: { translations: [{ translatedText: 'こんにちは' }] } });
    });

    await expect((provider.translateBatch as any)([{ id: 'a', text: 'Hello' }], 'en', 'ja'))
      .resolves.toEqual([{ id: 'a', text: 'こんにちは', provider: 'google' }]);
    expect(requestBody).toMatchObject({ source: 'en', target: 'ja' });
  });

  it('maps every Workers AI target to the requested model language label', async () => {
    const expected = {
      vi: 'vietnamese',
      en: 'english',
      zh: 'chinese',
      ja: 'japanese',
      ko: 'korean',
    } as const;
    const ai = new RecordingAI();
    const provider = new WorkersAITranslationProvider(ai);

    for (const target of TARGET_LANGUAGES) {
      await (provider.translateBatch as any)([{ id: target, text: 'Hello' }], 'en', target);
      expect(ai.calls.at(-1)?.input).toMatchObject({ source_lang: 'english', target_lang: expected[target] });
    }
  });

  it('passes the explicit target through the trusted contextual request boundary', async () => {
    const ai = new RecordingAI();
    const provider = new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model');

    await expect((provider.translateBatch as any)([{ id: 'a', text: 'Hello' }], 'en', 'ja', context))
      .resolves.toEqual([{ id: 'a', text: 'translated', provider: 'workers-ai-contextual' }]);

    const input = ai.calls[0]?.input as { messages: Array<{ role: string; content: string }> };
    expect(input.messages[0]?.content.toLowerCase()).toContain('japanese');
    expect(JSON.parse(input.messages[1]?.content ?? '{}')).toMatchObject({ targetLanguage: 'ja' });
  });

  it('routes a supported non-Vietnamese target through the selected raw provider', async () => {
    const workers = new StubProvider('workers-ai');
    const google = new StubProvider('google');
    const contextual = new StubProvider('workers-ai-contextual', TARGET_LANGUAGES, true);
    const router = new TranslationRouter(workers as any, google as any, contextual as any);

    await expect((router.translate as any)('google', [{ id: 'a', text: 'Hello' }], 'en', 'ja'))
      .resolves.toMatchObject({
        mode: 'google',
        primary: [{ id: 'a', text: 'google:ja:Hello', provider: 'google' }],
      });
    expect(google.calls).toEqual(['ja']);
    expect(workers.calls).toEqual([]);
  });

  it('rejects unsupported router targets before calling any provider', async () => {
    const workers = new StubProvider('workers-ai');
    const google = new StubProvider('google');
    const contextual = new StubProvider('workers-ai-contextual', TARGET_LANGUAGES, true);
    const router = new TranslationRouter(workers as any, google as any, contextual as any);

    await expect((router.translate as any)('google', [{ id: 'a', text: 'Hello' }], 'en', 'fr'))
      .rejects.toMatchObject({ code: 'TRANSLATION_TARGET_UNSUPPORTED' });
    expect(google.calls).toEqual([]);
  });

  it('rejects compare mode when either raw provider cannot serve the requested target', async () => {
    const workers = new StubProvider('workers-ai');
    const google = new StubProvider('google', ['vi']);
    const contextual = new StubProvider('workers-ai-contextual', TARGET_LANGUAGES, true);
    const router = new TranslationRouter(workers as any, google as any, contextual as any);

    await expect((router.translate as any)('compare', [{ id: 'a', text: 'Hello' }], 'en', 'ja'))
      .rejects.toMatchObject({ code: 'TRANSLATION_TARGET_UNSUPPORTED' });
    expect(workers.calls).toEqual([]);
    expect(google.calls).toEqual([]);
  });
});
