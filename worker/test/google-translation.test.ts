import { describe, expect, it } from 'vitest';
import { GoogleCloudTranslationProvider } from '../src/services/translation/google';

const activeContext = {
  revision: 3,
  style: 'formal' as const,
  glossary: [],
};

describe('Google Cloud Translation provider', () => {
  it('advertises raw-only availability from credential presence for every Phase 4C target', () => {
    expect(new GoogleCloudTranslationProvider('secret-key')).toHaveProperty(
      'capabilities',
      { contextual: false, available: true, targets: ['vi', 'en', 'zh', 'ja', 'ko'] },
    );
    expect(new GoogleCloudTranslationProvider('')).toHaveProperty(
      'capabilities',
      { contextual: false, available: false, targets: ['vi', 'en', 'zh', 'ja', 'ko'] },
    );
  });

  it('uses the official v2 endpoint, preserves order/ids, and decodes entities', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ data: { translations: [
        { translatedText: 'Xin chào &amp; chào mừng' },
        { translatedText: 'Thế giới' },
      ] } });
    };
    const provider = new GoogleCloudTranslationProvider('secret-key', fakeFetch);
    const result = await provider.translateBatch([
      { id: 'a', text: 'Hello & welcome' },
      { id: 'b', text: 'World' },
    ], 'en', 'vi');

    expect(result).toEqual([
      { id: 'a', text: 'Xin chào & chào mừng', provider: 'google' },
      { id: 'b', text: 'Thế giới', provider: 'google' },
    ]);
    expect(calls[0]?.url).toContain('https://translation.googleapis.com/language/translate/v2?key=secret-key');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      q: ['Hello & welcome', 'World'], source: 'en', target: 'vi', format: 'text',
    });
  });

  it('rejects missing credentials before network calls', async () => {
    let called = false;
    const provider = new GoogleCloudTranslationProvider('', async () => { called = true; return new Response(); });
    await expect(provider.translateBatch([{ id: 'a', text: 'Hello' }], 'en', 'vi')).rejects.toMatchObject({ code: 'GOOGLE_TRANSLATE_SECRET_MISSING' });
    expect(called).toBe(false);
  });

  it('rejects auto source until it is resolved', async () => {
    const provider = new GoogleCloudTranslationProvider('x', async () => Response.json({}));
    await expect(provider.translateBatch([{ id: 'a', text: 'Hello' }], 'auto', 'vi')).rejects.toMatchObject({ code: 'TRANSLATION_SOURCE_UNRESOLVED' });
  });

  it('fails closed if a direct raw-provider call would discard active context', async () => {
    const provider = new GoogleCloudTranslationProvider('secret-key', async () => Response.json({ data: { translations: [{ translatedText: 'x' }] } }));
    await expect((provider.translateBatch as any)([{ id: 'a', text: 'Hello' }], 'en', 'vi', activeContext))
      .rejects.toMatchObject({ code: 'TRANSLATION_CONTEXT_UNSUPPORTED' });
  });
});
