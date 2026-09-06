import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const entry = {
  id: 'g1',
  projectId: 'project-1',
  targetLanguage: 'vi' as const,
  sourceTerm: 'Acme',
  preferredTranslation: 'Acme',
  note: 'Brand name',
  caseSensitive: true,
  createdAt: '2026-09-06T00:00:00Z',
  updatedAt: '2026-09-06T00:00:00Z',
};

const input = {
  sourceTerm: 'Acme',
  preferredTranslation: 'Acme',
  note: 'Brand name',
  caseSensitive: true,
};

afterEach(() => vi.unstubAllGlobals());

describe('translation settings frontend api', () => {
  it('uses the exact six owner-scoped settings and Vietnamese compatibility glossary contracts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ stylePreset: 'neutral', contextRevision: 4, contextualAvailable: true }))
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'vi', contextRevision: 4, glossary: [] }))
      .mockResolvedValueOnce(jsonResponse({ stylePreset: 'formal', contextRevision: 5, contextualAvailable: true }))
      .mockResolvedValueOnce(jsonResponse({ entry, contextRevision: 5, context: { revision: 5, style: 'formal', glossary: [entry] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ entry: { ...entry, note: null }, contextRevision: 6, context: { revision: 6, style: 'formal', glossary: [{ ...entry, note: null }] } }))
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'vi', contextRevision: 7, context: { revision: 7, style: 'formal', glossary: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./translationSettingsApi');

    await api.loadTranslationSettings('project-1');
    await api.loadGlossary('project-1');
    await api.updateTranslationStyle('project-1', 4, 'formal');
    await api.createGlossaryEntry('project-1', 4, input);
    await api.updateGlossaryEntry('project-1', 'g/1', 5, { ...input, note: null });
    await api.deleteGlossaryEntry('project-1', 'g/1', 6);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/projects/project-1/translation-settings',
      expect.objectContaining({ headers: {} }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/projects/project-1/glossary?targetLanguage=vi',
      expect.objectContaining({ headers: {} }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      '/api/projects/project-1/translation-settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ expectedContextRevision: 4, stylePreset: 'formal' }),
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(fetchMock.mock.calls[3]).toEqual([
      '/api/projects/project-1/glossary',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedContextRevision: 4, ...input, targetLanguage: 'vi' }),
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(fetchMock.mock.calls[4]).toEqual([
      '/api/projects/project-1/glossary/g%2F1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ expectedContextRevision: 5, ...input, note: null, targetLanguage: 'vi' }),
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(fetchMock.mock.calls[5]).toEqual([
      '/api/projects/project-1/glossary/g%2F1?targetLanguage=vi',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ expectedContextRevision: 6 }),
        headers: { 'content-type': 'application/json' },
      }),
    ]);
  });

  it('carries an explicit target through list, create, update, and delete operations', async () => {
    const jaEntry = { ...entry, targetLanguage: 'ja' as const, preferredTranslation: 'アクメ' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'ja', contextRevision: 8, glossary: [jaEntry] }))
      .mockResolvedValueOnce(jsonResponse({ entry: jaEntry, contextRevision: 9, context: { revision: 9, style: 'neutral', glossary: [jaEntry] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ entry: jaEntry, contextRevision: 10, context: { revision: 10, style: 'neutral', glossary: [jaEntry] } }))
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'ja', contextRevision: 11, context: { revision: 11, style: 'neutral', glossary: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./translationSettingsApi');
    await api.loadGlossary('project-1', 'ja');
    await api.createGlossaryEntry('project-1', 8, { ...input, targetLanguage: 'ja', preferredTranslation: 'アクメ' });
    await api.updateGlossaryEntry('project-1', 'g1', 9, { ...input, targetLanguage: 'ja', preferredTranslation: 'アクメ' });
    await api.deleteGlossaryEntry('project-1', 'g1', 10, 'ja');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/project-1/glossary?targetLanguage=ja');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ targetLanguage: 'ja' });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ targetLanguage: 'ja' });
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/projects/project-1/glossary/g1?targetLanguage=ja');
  });

  it('converts a context revision conflict into a canonical recovery error', async () => {
    const canonical = { revision: 8, style: 'natural', glossary: [entry] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: true,
      code: 'TRANSLATION_CONTEXT_CONFLICT',
      message: 'Translation context changed elsewhere.',
      context: canonical,
    }, 409)));

    const api = await import('./translationSettingsApi');
    const promise = api.updateTranslationStyle('project-1', 7, 'formal');

    await expect(promise).rejects.toBeInstanceOf(api.TranslationContextConflictError);
    await expect(promise).rejects.toMatchObject({ canonical });
  });

  it('passes non-context API errors through unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: true,
      code: 'GLOSSARY_LIMIT_REACHED',
      message: 'Limit reached.',
    }, 409)));

    const api = await import('./translationSettingsApi');
    await expect(api.createGlossaryEntry('project-1', 4, input))
      .rejects.toMatchObject({ name: 'ApiError', code: 'GLOSSARY_LIMIT_REACHED', status: 409 });
  });
});
