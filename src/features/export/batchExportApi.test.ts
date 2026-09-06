import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4D batch export frontend api', () => {
  it('includes audio mode for dubbed single and batch requests while subtitles omit it', async () => {
    const single = { targetLanguage: 'ja', output: 'dubbed', exportId: 'e1', jobId: 'j1', workflowId: 'w1', status: 'queued' };
    const subtitles = { targetLanguage: 'ja', output: 'subtitles', exportId: 'e2', jobId: 'j2', workflowId: 'w2', status: 'queued' };
    const batch = {
      batchId: 'b1', exports: [
        { targetLanguage: 'vi', output: 'dubbed', exportId: 'e-vi', jobId: 'j-vi', workflowId: 'w-vi', status: 'queued' },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(single, 202))
      .mockResolvedValueOnce(jsonResponse(subtitles, 202))
      .mockResolvedValueOnce(jsonResponse(batch, 202));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./batchExportApi');
    await api.startLanguageExport('project/1', 'ja', 'dubbed', 'duck_original');
    await api.startLanguageExport('project/1', 'ja', 'subtitles', 'separated_background');
    await api.startBatchExport('project/1', ['vi'], 'dubbed', 'separated_background');

    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/projects/project%2F1/exports/ja',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ output: 'dubbed', audioMode: 'duck_original' }) }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/projects/project%2F1/exports/ja',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ output: 'subtitles' }) }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      '/api/projects/project%2F1/exports/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetLanguages: ['vi'], output: 'dubbed', audioMode: 'separated_background' }),
      }),
    ]);
  });

  it('defaults omitted dubbed audio mode to dubbed_only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      targetLanguage: 'vi', output: 'dubbed', exportId: 'e1', jobId: 'j1', status: 'queued',
    }, 202)));
    const api = await import('./batchExportApi');
    await api.startLanguageExport('p1', 'vi', 'dubbed');
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ output: 'dubbed', audioMode: 'dubbed_only' }),
    }));
  });

  it('fetches owner-scoped export capabilities', async () => {
    const capabilities = {
      duckOriginal: true,
      separation: {
        configured: false,
        provider: null,
        backgroundStem: false,
        dialogueStem: false,
        qualification: 'unavailable',
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(capabilities));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./batchExportApi');
    await expect(api.fetchExportCapabilities('project/1')).resolves.toEqual(capabilities);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project%2F1/export-capabilities', expect.objectContaining({ method: 'GET' }));
  });

  it('preserves partial batch launch response instead of throwing away successful targets', async () => {
    const payload = {
      batchId: 'b2', exports: [
        { targetLanguage: 'ko', output: 'dubbed', exportId: 'e-ko', jobId: 'j-ko', workflowId: 'w-ko', status: 'queued' },
        { targetLanguage: 'ja', output: 'dubbed', exportId: 'e-ja', jobId: 'j-ja', status: 'failed', code: 'EXPORT_WORKFLOW_START_FAILED', message: 'down' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload, 202)));
    const api = await import('./batchExportApi');
    await expect(api.startBatchExport('p1', ['ko', 'ja'], 'dubbed')).resolves.toEqual(payload);
  });
});
