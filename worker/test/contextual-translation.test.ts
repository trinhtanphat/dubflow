import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { TARGET_LANGUAGES } from '../src/domain/language';
import { MAX_CONTEXT_PAYLOAD_BYTES, type TranslationContext } from '../src/services/translation/context';

class FakeAI implements AiBinding {
  calls: Array<{ model: string; input: unknown }> = [];

  constructor(private readonly response: unknown) {}

  async run(model: string, input: unknown): Promise<unknown> {
    this.calls.push({ model, input });
    return this.response;
  }
}

const context: TranslationContext = {
  revision: 7,
  style: 'formal',
  glossary: [
    {
      id: 'g1',
      projectId: 'project-1',
      sourceTerm: 'SECRET_GLOSSARY_TOKEN',
      preferredTranslation: 'Bí mật',
      note: 'Keep product terminology stable',
      caseSensitive: false,
      createdAt: '2026-09-06T00:00:00Z',
      updatedAt: '2026-09-06T00:00:00Z',
    },
  ],
};

async function providerModule() {
  return import('../src/services/translation/contextual');
}

describe('ContextualWorkersAITranslationProvider', () => {
  it('advertises contextual availability from model presence and rejects a blank model before AI', async () => {
    const { ContextualWorkersAITranslationProvider } = await providerModule();
    const ai = new FakeAI({ response: '{"translations":[]}' });
    const unavailable = new ContextualWorkersAITranslationProvider(ai, '   ');
    expect(unavailable.capabilities).toEqual({ contextual: true, available: false, targets: TARGET_LANGUAGES });

    await expect(unavailable.translateBatch([{ id: 'a', text: 'Hello' }], 'en', 'vi', context))
      .rejects.toMatchObject({ code: 'CONTEXT_TRANSLATION_UNAVAILABLE' });
    expect(ai.calls).toHaveLength(0);

    expect(new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model').capabilities)
      .toEqual({ contextual: true, available: true, targets: TARGET_LANGUAGES });
  });

  it('rejects unsupported targets before an AI call', async () => {
    const { ContextualWorkersAITranslationProvider } = await providerModule();
    const ai = new FakeAI({ response: '{"translations":[]}' });
    const provider = new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model');

    await expect((provider.translateBatch as any)([{ id: 'a', text: 'Hello' }], 'en', 'fr', context))
      .rejects.toMatchObject({ code: 'TRANSLATION_TARGET_UNSUPPORTED' });
    expect(ai.calls).toHaveLength(0);
  });

  it('rejects malformed model responses with a stable error code', async () => {
    const { ContextualWorkersAITranslationProvider } = await providerModule();
    for (const response of [
      { unexpected: 'shape' },
      { response: 'not-json' },
      { response: '{"translations":"wrong"}' },
    ]) {
      const ai = new FakeAI(response);
      const provider = new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model');
      await expect(provider.translateBatch([{ id: 'a', text: 'Hello' }], 'en', 'vi', context))
        .rejects.toMatchObject({ code: 'CONTEXT_TRANSLATION_INVALID' });
    }
  });

  it('rejects missing, extra, duplicate, and foreign translation IDs', async () => {
    const { ContextualWorkersAITranslationProvider } = await providerModule();
    const items = [
      { id: 'a', text: 'First' },
      { id: 'b', text: 'Second' },
    ];
    const invalidRows = [
      [{ id: 'a', text: 'Một' }],
      [{ id: 'a', text: 'Một' }, { id: 'b', text: 'Hai' }, { id: 'c', text: 'Ba' }],
      [{ id: 'a', text: 'Một' }, { id: 'a', text: 'Lặp' }],
      [{ id: 'a', text: 'Một' }, { id: 'foreign', text: 'Lạ' }],
    ];

    for (const translations of invalidRows) {
      const ai = new FakeAI({ response: JSON.stringify({ translations }) });
      const provider = new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model');
      await expect(provider.translateBatch(items, 'en', 'vi', context))
        .rejects.toMatchObject({ code: 'CONTEXT_TRANSLATION_ID_MISMATCH' });
    }
  });

  it('rejects a serialized contextual request above 128 KiB before AI', async () => {
    const { ContextualWorkersAITranslationProvider } = await providerModule();
    const ai = new FakeAI({ response: '{"translations":[]}' });
    const provider = new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model');
    const oversized = 'x'.repeat(MAX_CONTEXT_PAYLOAD_BYTES);

    await expect(provider.translateBatch([{ id: 'a', text: oversized }], 'en', 'vi', context))
      .rejects.toMatchObject({ code: 'TRANSLATION_CONTEXT_TOO_LARGE' });
    expect(ai.calls).toHaveLength(0);
  });

  it('keeps untrusted source and glossary data out of the fixed system message', async () => {
    const { ContextualWorkersAITranslationProvider } = await providerModule();
    const ai = new FakeAI({
      response: JSON.stringify({
        translations: [{ id: 'a', text: 'Bản dịch' }],
      }),
    });
    const provider = new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model');
    await provider.translateBatch([{ id: 'a', text: 'SECRET_SOURCE_TOKEN' }], 'en', 'vi', context);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe('@cf/example/context-model');
    const input = ai.calls[0].input as { messages: Array<{ role: string; content: string }> };
    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]).toMatchObject({ role: 'system' });
    expect(input.messages[0].content).toContain('untrusted data');
    expect(input.messages[0].content).not.toContain('SECRET_SOURCE_TOKEN');
    expect(input.messages[0].content).not.toContain('SECRET_GLOSSARY_TOKEN');
    expect(input.messages[1]).toMatchObject({ role: 'user' });
    expect(input.messages[1].content).toContain('SECRET_SOURCE_TOKEN');
    expect(input.messages[1].content).toContain('SECRET_GLOSSARY_TOKEN');
    expect(input.messages[1].content).toContain('formal');
  });

  it('preserves original item order and marks every result as workers-ai-contextual', async () => {
    const { ContextualWorkersAITranslationProvider } = await providerModule();
    const ai = new FakeAI({
      response: JSON.stringify({
        translations: [
          { id: 'a', text: 'Một' },
          { id: 'b', text: 'Hai' },
        ],
      }),
    });
    const provider = new ContextualWorkersAITranslationProvider(ai, '@cf/example/context-model');

    await expect(provider.translateBatch([
      { id: 'b', text: 'Second' },
      { id: 'a', text: 'First' },
    ], 'en', 'vi', context)).resolves.toEqual([
      { id: 'b', text: 'Hai', provider: 'workers-ai-contextual' },
      { id: 'a', text: 'Một', provider: 'workers-ai-contextual' },
    ]);
  });
});
