import { describe, expect, it } from 'vitest';
import { JOB_POLL_INTERVAL_MS, pollJobUntilTerminal } from './jobPolling';
import type { CloudJob } from './jobApi';

const job = (status: CloudJob['status'], progress: number): CloudJob => ({
  id: 'j1', projectId: 'p1', type: 'dubbing', status, progress, currentStep: status === 'running' ? 'transcribing' : null, errorCode: null, errorMessage: null,
});

describe('job polling', () => {
  it('polls no faster than two seconds and stops at a terminal/review state', async () => {
    const queue = [job('running', 0.4), job('needs_review', 1)];
    const waits: number[] = [];
    const result = await pollJobUntilTerminal('p1', 'j1', {
      getJob: async () => queue.shift()!,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(JOB_POLL_INTERVAL_MS).toBe(2000);
    expect(waits).toEqual([2000]);
    expect(result.status).toBe('needs_review');
  });

  it('stops without another request after abort', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(pollJobUntilTerminal('p1', 'j1', {
      getJob: async () => { calls += 1; return job('running', 0.2); },
      sleep: async () => { controller.abort(); },
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });
});
