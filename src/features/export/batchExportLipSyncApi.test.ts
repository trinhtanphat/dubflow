import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4E frontend visual export request contract', () => {
  it('sends explicit visualMode for dubbed single and batch exports', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'ja', output: 'dubbed', exportId: 'e1', jobId: 'j1', status: 'queued', visualMode: 'lip_sync' }, 202))
      .mockResolvedValueOnce(jsonResponse({ batchId: 'b1', exports: [] }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./batchExportApi');

    await api.startLanguageExport('p1', 'ja', 'dubbed', 'duck_original', 'lip_sync');
    await api.startBatchExport('p1', ['vi', 'ko'], 'dubbed', 'dubbed_only', 'lip_sync');

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ output: 'dubbed', audioMode: 'duck_original', visualMode: 'lip_sync' }),
    }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ targetLanguages: ['vi', 'ko'], output: 'dubbed', audioMode: 'dubbed_only', visualMode: 'lip_sync' }),
    }));
  });

  it('defaults dubbed visualMode to standard and exposes capability typing without secret fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ targetLanguage: 'vi', output: 'dubbed', exportId: 'e1', jobId: 'j1', status: 'queued', visualMode: 'standard' }, 202))
      .mockResolvedValueOnce(jsonResponse({
        duckOriginal: true,
        separation: { configured: false, provider: null, backgroundStem: false, dialogueStem: false, qualification: 'unavailable' },
        visualLipSync: { available: false, provider: null },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./batchExportApi');

    await api.startLanguageExport('p1', 'vi', 'dubbed');
    const capabilities = await api.fetchExportCapabilities('p1');

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ output: 'dubbed', audioMode: 'dubbed_only', visualMode: 'standard' }),
    }));
    expect(capabilities.visualLipSync).toEqual({ available: false, provider: null });
  });
});
