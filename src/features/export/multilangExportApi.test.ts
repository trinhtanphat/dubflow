import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchExportVariants,
  fetchProjectTargets,
  saveProjectTargets,
  startBatchExport,
  targetExportMediaHref,
} from './multilangExportApi';

afterEach(() => vi.unstubAllGlobals());

describe('Phase 4C multilingual export API', () => {
  it('loads and saves bounded project targets through encoded routes', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (init?.method === 'PUT') return Response.json({ targets: ['vi', 'ja', 'en'] });
      return Response.json({ targets: ['vi', 'ja'] });
    });

    await expect(fetchProjectTargets('p / 1')).resolves.toEqual(['vi', 'ja']);
    await expect(saveProjectTargets('p / 1', ['ja', 'en'])).resolves.toEqual(['vi', 'ja', 'en']);

    expect(calls[0].input).toBe('/api/projects/p%20%2F%201/targets');
    expect(calls[1].input).toBe('/api/projects/p%20%2F%201/targets');
    expect(calls[1].init?.method).toBe('PUT');
    expect(calls[1].init?.body).toBe(JSON.stringify({ targetLanguages: ['ja', 'en'] }));
  });

  it('starts one batch for the exact selected targets and lists concrete export variants', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input).endsWith('/exports/batch')) {
        return Response.json({
          status: 'queued', batchId: 'batch-1',
          targets: [
            { targetLanguage: 'ja', exportId: 'ja-1', jobId: 'job-ja', workflowId: 'wf-ja', status: 'queued' },
            { targetLanguage: 'en', exportId: 'en-1', jobId: 'job-en', status: 'failed', errorCode: 'EXPORT_WORKFLOW_START_FAILED' },
          ],
        }, { status: 202 });
      }
      return Response.json([
        { id: 'ja-1', projectId: 'p1', batchId: 'batch-1', targetLanguage: 'ja', status: 'completed', objectKey: 'projects/p1/exports/ja/ja-1.mp4', jobId: 'job-ja', errorCode: null, generation: 0 },
      ]);
    });

    const batch = await startBatchExport('p1', ['ja', 'en']);
    const variants = await fetchExportVariants('p1');

    expect(calls[0].input).toBe('/api/projects/p1/exports/batch');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ targetLanguages: ['ja', 'en'] }));
    expect(batch).toMatchObject({ status: 'queued', batchId: 'batch-1' });
    expect(batch.targets).toHaveLength(2);
    expect(calls[1].input).toBe('/api/projects/p1/exports');
    expect(variants[0]).toMatchObject({ id: 'ja-1', targetLanguage: 'ja', status: 'completed' });
  });

  it('builds an owner media URL for one concrete variant', () => {
    expect(targetExportMediaHref('p / 1', 'ja / 1')).toBe('/api/projects/p%20%2F%201/exports/ja%20%2F%201/media');
  });
});
