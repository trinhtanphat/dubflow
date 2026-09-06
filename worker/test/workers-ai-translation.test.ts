import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { WorkersAITranslationProvider } from '../src/services/translation/workers-ai';

class FakeAI implements AiBinding {
  calls: { model: string; input: any }[] = [];
  async run(model: string, input: unknown): Promise<unknown> {
    this.calls.push({ model, input });
    return { translated_text: `VI:${(input as any).text}` };
  }
}

const activeContext = {
  revision: 3,
  style: 'formal' as const,
  glossary: [],
};

describe('Workers AI translation', () => {
  it('advertises raw-only availability', () => {
    const provider = new WorkersAITranslationProvider(new FakeAI());
    expect(provider).toHaveProperty('capabilities', { contextual: false, available: true });
  });

  it('preserves ids and maps source/target languages without trusting model identity', async () => {
    const ai = new FakeAI();
    const provider = new WorkersAITranslationProvider(ai);
    const result = await provider.translateBatch([
      { id: 'seg-1', text: '你好' },
      { id: 'seg-2', text: '世界' },
    ], 'zh', 'vi');

    expect(result).toEqual([
      { id: 'seg-1', text: 'VI:你好', provider: 'workers-ai' },
      { id: 'seg-2', text: 'VI:世界', provider: 'workers-ai' },
    ]);
    expect(ai.calls[0]).toMatchObject({
      model: '@cf/meta/m2m100-1.2b',
      input: { text: '你好', source_lang: 'chinese', target_lang: 'vietnamese' },
    });
  });

  it('keeps empty text empty without a provider call', async () => {
    const ai = new FakeAI();
    const provider = new WorkersAITranslationProvider(ai);
    const result = await provider.translateBatch([{ id: 'seg-1', text: '   ' }], 'en', 'vi');
    expect(result).toEqual([{ id: 'seg-1', text: '', provider: 'workers-ai' }]);
    expect(ai.calls.length).toBe(0);
  });

  it('normalizes all supported resolved source language labels', async () => {
    const ai = new FakeAI();
    const provider = new WorkersAITranslationProvider(ai);
    for (const [source, expected] of [['en','english'],['ja','japanese'],['ko','korean']] as const) {
      await provider.translateBatch([{ id: source, text: 'x' }], source, 'vi');
      expect(ai.calls.at(-1)?.input).toMatchObject({ source_lang: expected, target_lang: 'vietnamese' });
    }
  });

  it('fails closed if a direct raw-provider call would discard active context', async () => {
    const provider = new WorkersAITranslationProvider(new FakeAI());
    await expect((provider.translateBatch as any)([{ id: 'seg-1', text: 'Hello' }], 'en', 'vi', activeContext))
      .rejects.toMatchObject({ code: 'TRANSLATION_CONTEXT_UNSUPPORTED' });
  });
});
