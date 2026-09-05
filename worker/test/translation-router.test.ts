import { describe, expect, it } from 'vitest';
import type { SourceLanguage } from '../src/domain/project';
import type { TranslationItem, TranslationProvider, TranslationResult } from '../src/services/translation/types';
import { TranslationRouter } from '../src/services/translation/router';

class StubProvider implements TranslationProvider {
  constructor(private readonly name: string) {}
  async translateBatch(items: TranslationItem[], _source: SourceLanguage, _target: 'vi'): Promise<TranslationResult[]> {
    return items.map((item) => ({ id: item.id, text: `${this.name}:${item.text}`, provider: this.name }));
  }
}

describe('translation router', () => {
  it('selects workers-ai or google modes', async () => {
    const router = new TranslationRouter(new StubProvider('workers-ai'), new StubProvider('google'));
    expect(await router.translate('workers-ai', [{ id: '1', text: 'x' }], 'en', 'vi')).toEqual({
      mode: 'workers-ai', primary: [{ id: '1', text: 'workers-ai:x', provider: 'workers-ai' }],
    });
    expect(await router.translate('google', [{ id: '1', text: 'x' }], 'en', 'vi')).toEqual({
      mode: 'google', primary: [{ id: '1', text: 'google:x', provider: 'google' }],
    });
  });

  it('returns both alternatives in compare mode without choosing one', async () => {
    const router = new TranslationRouter(new StubProvider('workers-ai'), new StubProvider('google'));
    expect(await router.translate('compare', [{ id: '1', text: 'x' }], 'en', 'vi')).toEqual({
      mode: 'compare',
      workersAI: [{ id: '1', text: 'workers-ai:x', provider: 'workers-ai' }],
      google: [{ id: '1', text: 'google:x', provider: 'google' }],
    });
  });
});
