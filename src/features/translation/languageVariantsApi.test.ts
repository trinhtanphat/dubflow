import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4C language variant frontend api', () => {
  it('uses exact encoded language and variant owner routes with minimal JSON bodies', async () => {
    const config = { revision: 4, languages: [{ targetLanguage: 'ja', status: 'ready' }] };
    const translation = {
      segmentId: 'seg/1', projectId: 'project/1', targetLanguage: 'ja', translatedText: 'こんにちは',
      translationEngine: 'workers-ai', translationStatus: 'completed', translationContextRevision: 7,
      voiceStatus: 'pending', dubbedObjectKey: null, version: 3,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(config))
      .mockResolvedValueOnce(jsonResponse(config))
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'ja', segments: [{
        segmentId: 'seg/1', speakerId: 'sp1', startMs: 0, endMs: 1000, sourceText: 'Hello', sourceVersion: 2, translation,
      }] }))
      .mockResolvedValueOnce(jsonResponse({ translation }))
      .mockResolvedValueOnce(jsonResponse({ jobId: 'j1', workflowId: 'w1', status: 'queued', targetLanguage: 'ja' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./languageVariantsApi');
    await api.getProjectLanguages('project/1');
    await api.patchProjectLanguages('project/1', ['ja', 'ko'], 4);
    await api.getTranslationVariants('project/1', 'ja');
    await api.patchTranslationVariant('project/1', 'ja', 'seg/1', 3, 'こんにちは');
    await api.processTargetLanguage('project/1', 'ja');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/project%2F1/languages');
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/projects/project%2F1/languages',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ expectedRevision: 4, targetLanguages: ['ja', 'ko'] }) }),
    ]);
    expect(fetchMock.mock.calls[2][0]).toBe('/api/projects/project%2F1/translations/ja');
    expect(fetchMock.mock.calls[3]).toEqual([
      '/api/projects/project%2F1/translations/ja/seg%2F1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ expectedVersion: 3, translatedText: 'こんにちは' }) }),
    ]);
    expect(fetchMock.mock.calls[4]).toEqual([
      '/api/projects/project%2F1/translations/ja/process',
      expect.objectContaining({ method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[4][1]?.body).toBeUndefined();
  });

  it('converts project language CAS conflict into canonical recovery data', async () => {
    const canonical = { revision: 9, languages: [{ targetLanguage: 'vi', status: 'ready' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: true, code: 'PROJECT_LANGUAGES_CONFLICT', message: 'stale', canonical,
    }, 409)));
    const api = await import('./languageVariantsApi');
    const promise = api.patchProjectLanguages('p1', ['ja'], 8);
    await expect(promise).rejects.toBeInstanceOf(api.ProjectLanguagesConflictError);
    await expect(promise).rejects.toMatchObject({ canonical });
  });

  it('converts variant CAS conflict into only the canonical target variant', async () => {
    const canonical = {
      segmentId: 's1', projectId: 'p1', targetLanguage: 'ko', translatedText: '서버', translationEngine: 'workers-ai',
      translationStatus: 'completed', translationContextRevision: 5, voiceStatus: 'pending', dubbedObjectKey: null, version: 8,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: true, code: 'TRANSLATION_VARIANT_CONFLICT', message: 'stale', canonical,
    }, 409)));
    const api = await import('./languageVariantsApi');
    const promise = api.patchTranslationVariant('p1', 'ko', 's1', 7, 'local');
    await expect(promise).rejects.toBeInstanceOf(api.TranslationVariantConflictError);
    await expect(promise).rejects.toMatchObject({ canonical });
  });
});
