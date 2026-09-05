import type { CloudJob } from '../features/projects/jobApi';
import { pollJobUntilTerminal, type JobPollingOptions } from '../features/projects/jobPolling';
import { loadCloudStudioProject } from './cloudHydration';
import type { StudioProject } from '../features/timeline/types';

export class CloudJobError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CloudJobError';
  }
}

export type CloudJobFlowDeps = {
  poll: (
    projectId: string,
    jobId: string,
    options: JobPollingOptions,
    signal?: AbortSignal,
  ) => Promise<CloudJob>;
  hydrate: (projectId: string) => Promise<StudioProject>;
};

const defaultDeps: CloudJobFlowDeps = {
  poll: pollJobUntilTerminal,
  hydrate: loadCloudStudioProject,
};

export async function followCloudJob(
  projectId: string,
  jobId: string,
  deps: CloudJobFlowDeps = defaultDeps,
  signal?: AbortSignal,
  onJob?: (job: CloudJob) => void,
): Promise<StudioProject | null> {
  const terminal = await deps.poll(projectId, jobId, { onJob }, signal);
  onJob?.(terminal);
  if (terminal.status === 'needs_review' || terminal.status === 'completed') {
    return deps.hydrate(projectId);
  }
  if (terminal.status === 'failed') {
    throw new CloudJobError(terminal.errorCode ?? 'JOB_FAILED', terminal.errorMessage ?? 'AI dubbing job failed.');
  }
  if (terminal.status === 'cancelled') {
    throw new CloudJobError('JOB_CANCELLED', 'AI dubbing job was cancelled.');
  }
  return null;
}
