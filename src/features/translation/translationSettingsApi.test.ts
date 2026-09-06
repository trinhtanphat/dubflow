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
  targetLanguage: 'vi',
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
  it('uses the exact six owner-scoped settings and glossary HTTP contracts', async () => {
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
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/project-1/translation-settings');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/project-1/glossary?targetLanguage=vi');
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ expectedContextRevision: 4, stylePreset: 'formal' }),
    }));
    expect(fetchMock.mock.calls[3][1]).toEqual(expect.objectContaining({
      method: 'POST', body: JSON.stringify({ expectedContextRevision: 4, targetLanguage: 'vi', ...input }),
    }));
    expect(fetchMock.mock.calls[4][0]).toBe('/api/projects/project-1/glossary/g%2F1');
    expect(fetchMock.mock.calls[4][1]).toEqual(expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ expectedContextRevision: 5, targetLanguage: 'vi', ...input, note: null }),
    }));
    expect(fetchMock.mock.calls[5][1]).toEqual(expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ expectedContextRevision: 6, targetLanguage: 'vi' }),
    }));
  });

  it('sends and receives the selected glossary target language without making style target-specific', async () => {
    const jaEntry = { ...entry, id: 'g-ja', targetLanguage: 'ja', preferredTranslation: 'エーシーエムイー' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'ja', contextRevision: 9, glossary: [jaEntry] }))
      .mockResolvedValueOnce(jsonResponse({ entry: jaEntry, contextRevision: 10, context: { revision: 10, style: 'formal', glossary: [jaEntry] } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./translationSettingsApi');

    await expect(api.loadGlossary('project/1', 'ja')).resolves.toMatchObject({ targetLanguage: 'ja', glossary: [jaEntry] });
    await api.createGlossaryEntry('project/1', 9, input, 'ja');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/project%2F1/glossary?targetLanguage=ja');
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: 'POST', body: JSON.stringify({ expectedContextRevision: 9, targetLanguage: 'ja', ...input }),
    }));
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
