import { describe, expect, it, vi } from 'vitest';
import type { CloudJob } from '../features/projects/jobApi';
import type { CloudProject } from '../features/projects/projectApi';
import { cancelDashboardJob, retryDashboardJob } from './dashboardJobControl';

const failed: CloudJob = {
  id: 'j1', projectId: 'p1', type: 'dubbing', status: 'failed', progress: 0.4,
  currentStep: 'transcribing', errorCode: 'ASR_FAILED', errorMessage: 'down', retryCount: 1,
};
const completed: CloudJob = {
  ...failed, status: 'completed', progress: 1, currentStep: 'completed', errorCode: null, errorMessage: null, retryCount: 2,
};
const cancelled: CloudJob = {
  ...failed, status: 'cancelled', currentStep: 'cancelled', errorCode: null, errorMessage: null,
};
const project: CloudProject = {
  id: 'p1', userId: 'u', title: 'Episode 01', sourceLanguage: 'zh', targetLanguage: 'vi', status: 'completed',
};

describe('dashboard durable job controls', () => {
  it('retries the same job, polls it to a durable terminal state, then refreshes project metadata', async () => {
    const calls: string[] = [];
    const retryProjectJob = vi.fn(async () => { calls.push('retry'); return { jobId: 'j1', workflowId: 'wf-j1-2', status: 'retrying' as const }; });
    const pollJobUntilTerminal = vi.fn(async () => { calls.push('poll'); return completed; });
    const getProject = vi.fn(async () => { calls.push('project'); return project; });

    await expect(retryDashboardJob('p1', 'j1', { retryProjectJob, pollJobUntilTerminal, getProject }))
      .resolves.toEqual({ job: completed, project });
    expect(calls).toEqual(['retry', 'poll', 'project']);
    expect(retryProjectJob).toHaveBeenCalledWith('p1', 'j1');
    expect(pollJobUntilTerminal).toHaveBeenCalledWith('p1', 'j1');
    expect(getProject).toHaveBeenCalledWith('p1');
  });

  it('fails closed on retry-start error without polling or pretending project success', async () => {
    const pollJobUntilTerminal = vi.fn();
    const getProject = vi.fn();
    await expect(retryDashboardJob('p1', 'j1', {
      retryProjectJob: async () => { throw new Error('retry unavailable'); },
      pollJobUntilTerminal,
      getProject,
    })).rejects.toThrow('retry unavailable');
    expect(pollJobUntilTerminal).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
  });

  it('cancels through the canonical API response and refreshes current project metadata', async () => {
    const currentProject = { ...project, status: 'processing' as const };
    const cancelProjectJob = vi.fn(async () => cancelled);
    const getProject = vi.fn(async () => currentProject);

    await expect(cancelDashboardJob('p1', 'j1', { cancelProjectJob, getProject }))
      .resolves.toEqual({ job: cancelled, project: currentProject });
    expect(cancelProjectJob).toHaveBeenCalledWith('p1', 'j1');
    expect(getProject).toHaveBeenCalledWith('p1');
  });
});
