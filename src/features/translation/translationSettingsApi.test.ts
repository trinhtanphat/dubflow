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
      .mockResolvedValueOnce(jsonResponse({ contextRevision: 4, glossary: [] }))
      .mockResolvedValueOnce(jsonResponse({ stylePreset: 'formal', contextRevision: 5, contextualAvailable: true }))
      .mockResolvedValueOnce(jsonResponse({ entry, contextRevision: 5, context: { revision: 5, style: 'formal', glossary: [entry] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ entry: { ...entry, note: null }, contextRevision: 6, context: { revision: 6, style: 'formal', glossary: [{ ...entry, note: null }] } }))
      .mockResolvedValueOnce(jsonResponse({ contextRevision: 7, context: { revision: 7, style: 'formal', glossary: [] } }));
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
      '/api/projects/project-1/glossary',
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
        body: JSON.stringify({ expectedContextRevision: 4, ...input }),
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(fetchMock.mock.calls[4]).toEqual([
      '/api/projects/project-1/glossary/g%2F1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ expectedContextRevision: 5, ...input, note: null }),
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(fetchMock.mock.calls[5]).toEqual([
      '/api/projects/project-1/glossary/g%2F1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ expectedContextRevision: 6 }),
        headers: { 'content-type': 'application/json' },
      }),
    ]);
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
