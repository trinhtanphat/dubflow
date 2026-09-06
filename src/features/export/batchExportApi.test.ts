import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4C batch export frontend api', () => {
  it('launches one target export and one batch with exact encoded routes and bodies', async () => {
    const single = { targetLanguage: 'ja', output: 'subtitles', exportId: 'e1', jobId: 'j1', workflowId: 'w1', status: 'queued' };
    const batch = {
      batchId: 'b1', exports: [
        { targetLanguage: 'vi', output: 'dubbed', exportId: 'e-vi', jobId: 'j-vi', workflowId: 'w-vi', status: 'queued' },
        { targetLanguage: 'ja', output: 'dubbed', exportId: 'e-ja', jobId: 'j-ja', status: 'failed', code: 'EXPORT_WORKFLOW_START_FAILED', message: 'down' },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(single, 202))
      .mockResolvedValueOnce(jsonResponse(batch, 202));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./batchExportApi');
    await expect(api.startLanguageExport('project/1', 'ja', 'subtitles')).resolves.toEqual(single);
    await expect(api.startBatchExport('project/1', ['vi', 'ja'], 'dubbed')).resolves.toEqual(batch);

    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/projects/project%2F1/exports/ja',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ output: 'subtitles' }) }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/projects/project%2F1/exports/batch',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ targetLanguages: ['vi', 'ja'], output: 'dubbed', separationMode: 'source_mix' }) }),
    ]);
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

describe('Phase 4D export capability and separation payload', () => {
  it('loads project-scoped separation capability without exposing provider secrets', async () => {
    const payload = {
      dialogueBackgroundSeparation: {
        available: true,
        modes: ['source_mix', 'preserve_background'],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./batchExportApi');

    await expect(api.getExportCapabilities('project/1')).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project%2F1/export-capabilities', expect.anything());
    expect(JSON.stringify(payload)).not.toMatch(/api[_-]?key|secret|token/i);
  });

  it('propagates explicit preserve_background for dubbed single and batch exports', async () => {
    const single = { targetLanguage: 'vi', output: 'dubbed', exportId: 'e1', jobId: 'j1', workflowId: 'w1', status: 'queued' };
    const batch = { batchId: 'b1', exports: [single] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(single, 202))
      .mockResolvedValueOnce(jsonResponse(batch, 202));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./batchExportApi');

    await api.startLanguageExport('p1', 'vi', 'dubbed', 'preserve_background');
    await api.startBatchExport('p1', ['vi'], 'dubbed', 'preserve_background');

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ output: 'dubbed', separationMode: 'preserve_background' }),
    }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ targetLanguages: ['vi'], output: 'dubbed', separationMode: 'preserve_background' }),
    }));
  });

  it('keeps subtitles free of stem-separation mode even when preserve_background was selected in Studio', async () => {
    const single = { targetLanguage: 'ja', output: 'subtitles', exportId: 'e1', jobId: 'j1', workflowId: 'w1', status: 'queued' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(single, 202));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./batchExportApi');

    await api.startLanguageExport('p1', 'ja', 'subtitles', 'preserve_background');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ output: 'subtitles' }),
    }));
  });
});
