import { getJob, type CloudJob } from './jobApi';

export const JOB_POLL_INTERVAL_MS = 2000;

const TERMINAL_STATUSES = new Set<CloudJob['status']>(['needs_review', 'failed', 'completed', 'cancelled']);

export type JobPollingOptions = {
  getJob?: typeof getJob;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onJob?: (job: CloudJob) => void;
};

function abortError(): Error {
  const error = new Error('Job polling aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
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
  const readJob = options.getJob ?? getJob;
  const wait = options.sleep ?? sleep;
  for (;;) {
    throwIfAborted(signal);
    const job = await readJob(projectId, jobId);
    if (TERMINAL_STATUSES.has(job.status)) return job;
    options.onJob?.(job);
    await wait(JOB_POLL_INTERVAL_MS, signal);
    throwIfAborted(signal);
  }
}
