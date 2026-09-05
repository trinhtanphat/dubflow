import { cancelProjectJob, retryProjectJob, type CloudJob } from '../features/projects/jobApi';
import { pollJobUntilTerminal } from '../features/projects/jobPolling';
import { getProject, type CloudProject } from '../features/projects/projectApi';

export type DashboardJobResult = {
  job: CloudJob;
  project: CloudProject;
};

export type RetryDashboardJobDeps = {
  retryProjectJob: typeof retryProjectJob;
  pollJobUntilTerminal: (projectId: string, jobId: string) => Promise<CloudJob>;
  getProject: typeof getProject;
};

const retryDeps: RetryDashboardJobDeps = {
  retryProjectJob,
  pollJobUntilTerminal,
  getProject,
};

export async function retryDashboardJob(
  projectId: string,
  jobId: string,
  deps: RetryDashboardJobDeps = retryDeps,
): Promise<DashboardJobResult> {
  await deps.retryProjectJob(projectId, jobId);
  const job = await deps.pollJobUntilTerminal(projectId, jobId);
  const project = await deps.getProject(projectId);
  return { job, project };
}

export type CancelDashboardJobDeps = {
  cancelProjectJob: typeof cancelProjectJob;
  getProject: typeof getProject;
};

const cancelDeps: CancelDashboardJobDeps = { cancelProjectJob, getProject };

export async function cancelDashboardJob(
  projectId: string,
  jobId: string,
  deps: CancelDashboardJobDeps = cancelDeps,
): Promise<DashboardJobResult> {
  const job = await deps.cancelProjectJob(projectId, jobId);
  const project = await deps.getProject(projectId);
  return { job, project };
}
