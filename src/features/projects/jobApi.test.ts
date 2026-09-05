import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJob, startExport, startProcessing } from './jobApi';

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
      if (calls.length === 1) return Response.json({ id: 'job-1', projectId: 'p', type: 'dubbing', status: 'running', progress: 0.5, currentStep: 'transcribing', errorCode: null, errorMessage: null });
      return Response.json({ error: true, code: 'JOB_NOT_FOUND', message: 'Job not found.' }, { status: 404 });
    });

    await expect(getJob('p', 'job-1')).resolves.toMatchObject({ status: 'running', progress: 0.5, currentStep: 'transcribing' });
    await expect(getJob('p', 'missing')).rejects.toMatchObject({ status: 404, code: 'JOB_NOT_FOUND' });
    expect(calls).toEqual(['/api/projects/p/jobs/job-1', '/api/projects/p/jobs/missing']);
  });
});
