import { describe, expect, it, vi } from 'vitest';
import type { CloudJob } from '../features/projects/jobApi';
import type { CloudProject } from '../features/projects/projectApi';
import {
  cancelDashboardJob,
  createDashboardProject,
  loadProjectDashboardSnapshot,
  openDashboardProject,
  retryDashboardJob,
} from './projectDashboardFlow';

const projects: CloudProject[] = [
  { id: 'p1', userId: 'u', title: 'One', sourceLanguage: 'zh', targetLanguage: 'vi', status: 'needs_review' },
  { id: 'p2', userId: 'u', title: 'Two', sourceLanguage: 'en', targetLanguage: 'vi', status: 'failed' },
];

const jobs: Record<string, CloudJob[]> = {
  p1: [{ id: 'j1', projectId: 'p1', type: 'dubbing', status: 'needs_review', progress: 1, currentStep: null, errorCode: null, errorMessage: null }],
  p2: [{ id: 'j2', projectId: 'p2', type: 'dubbing', status: 'failed', progress: 0.4, currentStep: 'transcribing', errorCode: 'ASR_FAILED', errorMessage: 'down' }],
};

describe('project dashboard flow', () => {
  it('loads projects then durable job histories keyed by project id', async () => {
    const listProjectJobs = vi.fn(async (projectId: string) => jobs[projectId]);
    const result = await loadProjectDashboardSnapshot({
      listProjects: async () => projects,
      listProjectJobs,
    });

    expect(result.projects).toEqual(projects);
    expect(result.jobsByProject).toEqual(jobs);
    expect(listProjectJobs.mock.calls.map(([id]) => id)).toEqual(['p1', 'p2']);
  });

  it('returns an empty jobs map when there are no projects', async () => {
    const listProjectJobs = vi.fn();
    await expect(loadProjectDashboardSnapshot({
      listProjects: async () => [],
      listProjectJobs,
    })).resolves.toEqual({ projects: [], jobsByProject: {} });
    expect(listProjectJobs).not.toHaveBeenCalled();
  });

  it('hydrates the canonical Studio project when opening a dashboard item', async () => {
    const studio = { id: 'p1', title: 'One', durationMs: 1000, sourceLanguage: 'zh' as const, targetLanguage: 'vi' as const, speakers: [], segments: [] };
    const loadCloudStudioProject = vi.fn(async () => studio);
    await expect(openDashboardProject('p1', { loadCloudStudioProject })).resolves.toEqual(studio);
    expect(loadCloudStudioProject).toHaveBeenCalledWith('p1');
  });

  it('retries a durable failed job and reloads that project job history', async () => {
    const retryProjectJob = vi.fn(async () => ({ jobId: 'j2', workflowId: 'wf-retry', status: 'retrying' as const }));
    const refreshed: CloudJob[] = [{ ...jobs.p2[0]!, status: 'retrying', retryCount: 1, errorCode: null, errorMessage: null }];
    const listProjectJobs = vi.fn(async () => refreshed);

    await expect(retryDashboardJob('p2', 'j2', { retryProjectJob, listProjectJobs })).resolves.toEqual(refreshed);
    expect(retryProjectJob).toHaveBeenCalledWith('p2', 'j2');
    expect(listProjectJobs).toHaveBeenCalledWith('p2');
  });

  it('cancels an active durable job and reloads that project job history', async () => {
    const cancelled = { ...jobs.p2[0]!, status: 'cancelled' as const, errorCode: null, errorMessage: null };
    const cancelProjectJob = vi.fn(async () => cancelled);
    const listProjectJobs = vi.fn(async () => [cancelled]);

    await expect(cancelDashboardJob('p2', 'j2', { cancelProjectJob, listProjectJobs })).resolves.toEqual([cancelled]);
    expect(cancelProjectJob).toHaveBeenCalledWith('p2', 'j2');
    expect(listProjectJobs).toHaveBeenCalledWith('p2');
  });

  it('creates a durable project before hydrating its Studio state', async () => {
    const created: CloudProject = { id: 'new-p', userId: 'u', title: 'Dự án mới', sourceLanguage: 'auto', targetLanguage: 'vi', status: 'draft' };
    const studio = { id: 'new-p', title: 'Dự án mới', durationMs: 0, sourceLanguage: 'auto' as const, targetLanguage: 'vi' as const, speakers: [], segments: [] };
    const createProject = vi.fn(async () => created);
    const loadCloudStudioProject = vi.fn(async () => studio);

    await expect(createDashboardProject(' Dự án mới ', { createProject, loadCloudStudioProject })).resolves.toEqual(studio);
    expect(createProject).toHaveBeenCalledWith('Dự án mới', 'auto');
    expect(loadCloudStudioProject).toHaveBeenCalledWith('new-p');
  });
});
