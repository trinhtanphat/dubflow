import type { JobStore } from '../db/jobs';

export class JobCancelledError extends Error {
  readonly code = 'JOB_CANCELLED';

  constructor(message = 'Job was cancelled.') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export async function assertJobActive(
  jobs: Pick<JobStore, 'getForProject'>,
  projectId: string,
  jobId: string,
  userId: string,
): Promise<void> {
  const job = await jobs.getForProject(projectId, jobId, userId);
  if (!job) throw new Error('Job not found.');
  if (job.status === 'cancelled') throw new JobCancelledError();
}

export function isJobCancelledError(error: unknown): error is JobCancelledError {
  return error instanceof JobCancelledError || (
    error instanceof Error && 'code' in error && (error as Error & { code?: string }).code === 'JOB_CANCELLED'
  );
}