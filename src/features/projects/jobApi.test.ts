import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelProjectJob,
  getJob,
  listProjectJobs,
  retryProjectJob,
  startExport,
  startProcessing,
} from './jobApi';

afterEach(() => vi.unstubAllGlobals());

describe('dubbing job API', () => {
  it('starts processing and decodes the queued Workflow identity', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({ jobId: 'job-1', workflowId: 'workflow-1', status: 'queued' });
    });

    await expect(startProcessing('project / 1')).resolves.toEqual({ jobId: 'job-1', workflowId: 'workflow-1', status: 'queued' });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/api/projects/project%20%2F%201/process');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('starts final export through the project-scoped export endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({ jobId: 'job-export', workflowId: 'workflow-export', status: 'queued' });
    });

    await expect(startExport('project / 1')).resolves.toEqual({ jobId: 'job-export', workflowId: 'workflow-export', status: 'queued' });
    expect(calls[0].input).toBe('/api/projects/project%20%2F%201/export');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('reads a project-scoped durable job and preserves structured errors', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) return Response.json({
        id: 'job-1', projectId: 'p', type: 'dubbing', status: 'running', progress: 0.5,
        currentStep: 'transcribing', errorCode: null, errorMessage: null,
        retryCount: 1, createdAt: '2026-09-05T12:00:00Z', updatedAt: '2026-09-05T12:05:00Z',
      });
      return Response.json({ error: true, code: 'JOB_NOT_FOUND', message: 'Job not found.' }, { status: 404 });
    });

    await expect(getJob('p', 'job-1')).resolves.toMatchObject({
      status: 'running', progress: 0.5, currentStep: 'transcribing', retryCount: 1,
      createdAt: '2026-09-05T12:00:00Z', updatedAt: '2026-09-05T12:05:00Z',
    });
    await expect(getJob('p', 'missing')).rejects.toMatchObject({ status: 404, code: 'JOB_NOT_FOUND' });
    expect(calls).toEqual(['/api/projects/p/jobs/job-1', '/api/projects/p/jobs/missing']);
  });

  it('lists project job history through an encoded project URL', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json([{
        id: 'j2', projectId: 'p 1', type: 'export', status: 'failed', progress: 0.6,
        currentStep: 'rendering', errorCode: 'RENDER_FAILED', errorMessage: 'boom',
        retryCount: 2, createdAt: '2026-09-05T13:00:00Z', updatedAt: '2026-09-05T13:05:00Z',
      }]);
    });

    await expect(listProjectJobs('p 1')).resolves.toEqual([
      expect.objectContaining({ id: 'j2', retryCount: 2 }),
    ]);
    expect(calls).toEqual(['/api/projects/p%201/jobs']);
  });

  it('retries a failed job generation through the encoded project/job route', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({ jobId: 'j/1', workflowId: 'wf-j1-2', status: 'retrying' }, { status: 202 });
    });

    await expect(retryProjectJob('p1', 'j/1')).resolves.toEqual({ jobId: 'j/1', workflowId: 'wf-j1-2', status: 'retrying' });
    expect(calls[0].input).toBe('/api/projects/p1/jobs/j%2F1/retry');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('cancels an active job and returns canonical durable state', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Response.json({
        id: 'j1', projectId: 'p1', type: 'dubbing', status: 'cancelled', progress: 0.3,
        currentStep: 'cancelled', errorCode: null, errorMessage: null,
        retryCount: 0, createdAt: '2026-09-05T12:00:00Z', updatedAt: '2026-09-05T12:06:00Z',
      });
    });

    await expect(cancelProjectJob('p1', 'j1')).resolves.toMatchObject({ id: 'j1', status: 'cancelled' });
    expect(calls[0].input).toBe('/api/projects/p1/jobs/j1/cancel');
    expect(calls[0].init?.method).toBe('POST');
  });
});
