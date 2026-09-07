import { getProjectJob, type CloudJob } from './jobApi';

export const JOB_POLL_INTERVAL_MS = 2000;

const TERMINAL_STATUSES = new Set<CloudJob['status']>([
  'needs_review',
  'completed',
  'failed',
  'cancelled',
]);

export type JobPollingOptions = {
  getJob?: typeof getProjectJob;
  sleep?: (ms: number) => Promise<void>;
  onJob?: (job: CloudJob) => void;
};

function abortError(): Error {
  const error = new Error('Job polling aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollJobUntilTerminal(
  projectId: string,
  jobId: string,
  options: JobPollingOptions = {},
  signal?: AbortSignal,
): Promise<CloudJob> {
  const readJob = options.getJob ?? getProjectJob;
  const wait = options.sleep ?? ((ms: number) => defaultSleep(ms, signal));

  for (;;) {
    throwIfAborted(signal);
    const job = await readJob(projectId, jobId);
    options.onJob?.(job);
    if (TERMINAL_STATUSES.has(job.status)) return job;
    await wait(JOB_POLL_INTERVAL_MS);
  }
}
