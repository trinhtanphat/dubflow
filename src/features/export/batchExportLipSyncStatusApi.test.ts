import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4E export status polling API', () => {
  it('loads the canonical latest export attempt including visual state', async () => {
    const attempt = {
      id: 'e1',
      projectId: 'project/1',
      targetLanguage: 'vi',
      output: 'dubbed',
      batchId: null,
      audioMode: 'dubbed_only',
      status: 'completed',
      exportObjectKey: 'projects/project/1/exports/vi/e1.mp4',
      subtitleObjectKey: null,
      lipSyncRequested: true,
      lipSyncProvider: 'sync-labs',
      lipSyncStatus: 'failed',
      lipSyncObjectKey: null,
      errorCode: null,
      errorMessage: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(attempt));
    vi.stubGlobal('fetch', fetchMock);
    const api = await import('./batchExportApi');

    await expect(api.fetchLatestLanguageExport('project/1', 'vi', 'dubbed')).resolves.toEqual(attempt);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project%2F1/exports/vi?output=dubbed',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('builds an owner-scoped standard fallback media URL without exposing object keys', async () => {
    const api = await import('./batchExportApi');
    expect(api.exportMediaUrl('project/1', 'ja', 'dubbed')).toBe(
      '/api/projects/project%2F1/exports/ja/media?output=dubbed',
    );
  });
});
