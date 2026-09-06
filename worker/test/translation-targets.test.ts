import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { ContextualWorkersAITranslationProvider } from '../src/services/translation/contextual';
import { GoogleCloudTranslationProvider } from '../src/services/translation/google';
import { TranslationRouter } from '../src/services/translation/router';
import type { TranslationItem, TranslationProvider, TranslationResult } from '../src/services/translation/types';
import { WorkersAITranslationProvider } from '../src/services/translation/workers-ai';

const TARGETS = ['vi', 'en', 'zh', 'ja', 'ko'] as const;

class RecordingProvider implements TranslationProvider {
  calls = 0;
  readonly capabilities: any;

  constructor(targets: readonly string[]) {
    this.capabilities = { contextual: false, available: true, targets };
  }

  async translateBatch(items: TranslationItem[], _source: any, _target: any): Promise<TranslationResult[]> {
    this.calls += 1;
    return items.map((item) => ({ id: item.id, text: item.text, provider: 'recording' }));
  }
}

describe('Phase 4C multi-target translation providers', () => {
  it('declares the exact five supported targets on raw providers', () => {
    const workers = new WorkersAITranslationProvider({ async run() { return { translated_text: 'ok' }; } } as AiBinding);
    const google = new GoogleCloudTranslationProvider('key', async () => Response.json({ data: { translations: [] } }));
    expect((workers.capabilities as any).targets).toEqual(TARGETS);
    expect((google.capabilities as any).targets).toEqual(TARGETS);
  });

  it('maps Workers AI target language dynamically', async () => {
    const inputs: unknown[] = [];
    const provider = new WorkersAITranslationProvider({
      async run(_model: string, input: unknown) {
        inputs.push(input);
        return { translated_text: '訳' };
      },
    } as AiBinding);

    await (provider.translateBatch as any)([{ id: 's1', text: 'hello' }], 'en', 'ja');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ source_lang: 'english', target_lang: 'japanese' });
  });

  it('sends the requested target code to Google Cloud Translation', async () => {
    let body: any;
    const provider = new GoogleCloudTranslationProvider('key', async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ data: { translations: [{ translatedText: '訳' }] } });
    });

    await (provider.translateBatch as any)([{ id: 's1', text: 'hello' }], 'en', 'ja');
    expect(body).toMatchObject({ source: 'en', target: 'ja', format: 'text' });
  });

  it('rejects an unsupported target before invoking any provider', async () => {
    const workers = new RecordingProvider(TARGETS);
    const google = new RecordingProvider(TARGETS);
    const router = new TranslationRouter(workers, google);

    await expect((router.translate as any)('workers-ai', [{ id: 's1', text: 'hello' }], 'en', 'fr'))
      .rejects.toMatchObject({ code: 'TRANSLATION_TARGET_UNSUPPORTED' });
    expect(workers.calls).toBe(0);
    expect(google.calls).toBe(0);
  });

  it('validates both compare providers before starting either request', async () => {
    const workers = new RecordingProvider(TARGETS);
    const google = new RecordingProvider(['vi']);
    const router = new TranslationRouter(workers, google);

    await expect((router.translate as any)('compare', [{ id: 's1', text: 'hello' }], 'en', 'ja'))
      .rejects.toMatchObject({ code: 'TRANSLATION_TARGET_UNSUPPORTED' });
    expect(workers.calls).toBe(0);
    expect(google.calls).toBe(0);
  });

  it('passes the requested target explicitly in contextual trusted instruction and project payload', async () => {
    let input: any;
    const provider = new ContextualWorkersAITranslationProvider({
      async run(_model: string, nextInput: unknown) {
        input = nextInput;
        return { response: JSON.stringify({ translations: [{ id: 's1', text: '訳' }] }) };
      },
    } as AiBinding, '@cf/context-model');

    await (provider.translateBatch as any)(
      [{ id: 's1', text: 'hello' }],
      'en',
      'ja',
      { revision: 3, style: 'natural', glossary: [] },
    );

    expect((provider.capabilities as any).targets).toEqual(TARGETS);
    expect(input.messages[0].content).toContain('Japanese');
    expect(JSON.parse(input.messages[1].content)).toMatchObject({ targetLanguage: 'ja' });
  });
});
