import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4C/4D batch export frontend api', () => {
  it('launches subtitles without audio-only fields and dubbed exports with the exact selected mix mode', async () => {
    const single = { targetLanguage: 'ja', output: 'subtitles', exportId: 'e1', jobId: 'j1', workflowId: 'w1', status: 'queued', mixMode: 'dubbed_only' };
    const batch = {
      batchId: 'b1', exports: [
        { targetLanguage: 'vi', output: 'dubbed', exportId: 'e-vi', jobId: 'j-vi', workflowId: 'w-vi', status: 'queued', mixMode: 'preserve_background' },
        { targetLanguage: 'ja', output: 'dubbed', exportId: 'e-ja', jobId: 'j-ja', status: 'failed', code: 'EXPORT_WORKFLOW_START_FAILED', message: 'down', mixMode: 'preserve_background' },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(single, 202))
      .mockResolvedValueOnce(jsonResponse(batch, 202));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./batchExportApi');
    await expect(api.startLanguageExport('project/1', 'ja', 'subtitles')).resolves.toEqual(single);
    await expect(api.startBatchExport('project/1', ['vi', 'ja'], 'dubbed', 'preserve_background')).resolves.toEqual(batch);

    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/projects/project%2F1/exports/ja',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ output: 'subtitles' }) }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/projects/project%2F1/exports/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetLanguages: ['vi', 'ja'], output: 'dubbed', mixMode: 'preserve_background' }),
      }),
    ]);
  });

  it('preserves partial batch launch response instead of throwing away successful targets', async () => {
    const payload = {
      batchId: 'b2', exports: [
        { targetLanguage: 'ko', output: 'dubbed', exportId: 'e-ko', jobId: 'j-ko', workflowId: 'w-ko', status: 'queued', mixMode: 'dubbed_only' },
        { targetLanguage: 'ja', output: 'dubbed', exportId: 'e-ja', jobId: 'j-ja', status: 'failed', code: 'EXPORT_WORKFLOW_START_FAILED', message: 'down', mixMode: 'dubbed_only' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload, 202)));
    const api = await import('./batchExportApi');
    await expect(api.startBatchExport('p1', ['ko', 'ja'], 'dubbed', 'dubbed_only')).resolves.toEqual(payload);
  });
});
