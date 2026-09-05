import type { D1DatabaseLike, D1RunResultLike } from './projects';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'needs_review'
  | 'retrying'
  | 'failed'
  | 'completed'
  | 'cancelled';

export type DubbingJob = {
  id: string;
  projectId: string;
  type: string;
  status: JobStatus;
  progress: number;
  currentStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

export interface JobStore {
  create(projectId: string, type: string): Promise<DubbingJob>;
  listForProject(projectId: string, userId: string): Promise<DubbingJob[]>;
  getForProject(projectId: string, jobId: string, userId: string): Promise<DubbingJob | null>;
  markRetrying(projectId: string, jobId: string, userId: string): Promise<DubbingJob>;
  cancel(projectId: string, jobId: string, userId: string): Promise<DubbingJob>;
  isCancelled(projectId: string, jobId: string, userId: string): Promise<boolean>;
  setProgress(jobId: string, progress: number, currentStep: string): Promise<void>;
  fail(jobId: string, errorCode: string, errorMessage: string): Promise<void>;
  complete(jobId: string, status?: 'completed' | 'needs_review'): Promise<void>;
}

export class JobStateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'JobStateError';
  }
}

export function assertProgressTransition(previous: number, next: number): void {
  if (!Number.isFinite(previous) || previous < 0 || previous > 1) {
    throw new JobStateError('JOB_PROGRESS_STATE_INVALID', 'Stored job progress is invalid.');
  }
  if (!Number.isFinite(next) || next < 0 || next > 1) {
    throw new JobStateError('JOB_PROGRESS_INVALID', 'Job progress must be between 0 and 1.');
  }
  if (next < previous) {
    throw new JobStateError('JOB_PROGRESS_REGRESSION', 'Job progress cannot move backwards.');
  }
}

type JobRow = {
  id: string;
  project_id: string;
  type: string;
  status: JobStatus;
  progress: number;
  current_step: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
};

function fromRow(row: JobRow): DubbingJob {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    currentStep: row.current_step,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryCount: row.retry_count ?? 0,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? row.created_at ?? '',
  };
}

function affectedRows(result: D1RunResultLike): number {
  const changes = result.meta?.changes ?? result.changes ?? 0;
  return Number.isFinite(changes) ? Math.max(0, Number(changes)) : 0;
}

const JOB_COLUMNS = `j.id, j.project_id, j.type, j.status, j.progress, j.current_step, j.error_code, j.error_message,
 j.retry_count, j.created_at, j.updated_at`;

const JOB_COLUMNS_UNQUALIFIED = `id, project_id, type, status, progress, current_step, error_code, error_message,
 retry_count, created_at, updated_at`;

export class JobRepository implements JobStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async create(projectId: string, type: string): Promise<DubbingJob> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO jobs (id, project_id, type, status, progress) VALUES (?, ?, ?, 'queued', 0)`,
    ).bind(id, projectId, type).run();
    return {
      id,
      projectId,
      type,
      status: 'queued',
      progress: 0,
      currentStep: null,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async listForProject(projectId: string, userId: string): Promise<DubbingJob[]> {
    const result = await this.db.prepare(
      `SELECT ${JOB_COLUMNS}
       FROM jobs j
       INNER JOIN projects p ON p.id = j.project_id
       WHERE j.project_id = ? AND p.user_id = ?
       ORDER BY j.created_at DESC, j.id DESC`,
    ).bind(projectId, userId).all<JobRow>();
    return (result.results ?? []).map(fromRow);
  }

  async getForProject(projectId: string, jobId: string, userId: string): Promise<DubbingJob | null> {
    const row = await this.db.prepare(
      `SELECT ${JOB_COLUMNS}
       FROM jobs j
       INNER JOIN projects p ON p.id = j.project_id
       WHERE j.project_id = ? AND j.id = ? AND p.user_id = ?
       LIMIT 1`,
    ).bind(projectId, jobId, userId).first<JobRow>();
    return row ? fromRow(row) : null;
  }

  private async getById(jobId: string): Promise<DubbingJob | null> {
    const row = await this.db.prepare(
      `SELECT ${JOB_COLUMNS_UNQUALIFIED}
       FROM jobs WHERE id = ? LIMIT 1`,
    ).bind(jobId).first<JobRow>();
    return row ? fromRow(row) : null;
  }

  async markRetrying(projectId: string, jobId: string, userId: string): Promise<DubbingJob> {
    const result = await this.db.prepare(
      `UPDATE jobs
       SET status = 'retrying', progress = 0, current_step = 'retrying',
           error_code = NULL, error_message = NULL,
           retry_count = retry_count + 1, updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND status = 'failed'
         AND EXISTS (
           SELECT 1 FROM projects p
           WHERE p.id = jobs.project_id AND p.user_id = ?
         )`,
    ).bind(jobId, projectId, userId).run();

    if (affectedRows(result) !== 1) {
      const current = await this.getForProject(projectId, jobId, userId);
      if (!current) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
      throw new JobStateError('JOB_NOT_RETRYABLE', 'Only failed jobs can be retried.');
    }

    const current = await this.getForProject(projectId, jobId, userId);
    if (!current) throw new JobStateError('JOB_NOT_FOUND', 'Job not found after retry transition.');
    return current;
  }

  async cancel(projectId: string, jobId: string, userId: string): Promise<DubbingJob> {
    const result = await this.db.prepare(
      `UPDATE jobs
       SET status = 'cancelled', current_step = 'cancelled', updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND status IN ('queued', 'running', 'retrying')
         AND EXISTS (
           SELECT 1 FROM projects p
           WHERE p.id = jobs.project_id AND p.user_id = ?
         )`,
    ).bind(jobId, projectId, userId).run();

    if (affectedRows(result) !== 1) {
      const current = await this.getForProject(projectId, jobId, userId);
      if (!current) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
      throw new JobStateError('JOB_NOT_CANCELLABLE', 'Only queued, running, or retrying jobs can be cancelled.');
    }

    const current = await this.getForProject(projectId, jobId, userId);
    if (!current) throw new JobStateError('JOB_NOT_FOUND', 'Job not found after cancellation.');
    return current;
  }

  async isCancelled(projectId: string, jobId: string, userId: string): Promise<boolean> {
    const current = await this.getForProject(projectId, jobId, userId);
    return current?.status === 'cancelled';
  }

  async setProgress(jobId: string, progress: number, currentStep: string): Promise<void> {
    const job = await this.getById(jobId);
    if (!job) throw new JobStateError('JOB_NOT_FOUND', 'Job not found.');
    if (['completed', 'failed', 'cancelled', 'needs_review'].includes(job.status)) {
      throw new JobStateError('JOB_TERMINAL', 'Terminal jobs cannot change progress.');
    }
    assertProgressTransition(job.progress, progress);
    await this.db.prepare(
      `UPDATE jobs
       SET status = 'running', progress = ?, current_step = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(progress, currentStep, jobId).run();
  }

  async fail(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.db.prepare(
      `UPDATE jobs
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = datetime('now')
       WHERE id = ? AND status != 'cancelled'`,
    ).bind(errorCode, errorMessage, jobId).run();
  }

  async complete(jobId: string, status: 'completed' | 'needs_review' = 'completed'): Promise<void> {
    await this.db.prepare(
      `UPDATE jobs
       SET status = ?, progress = 1, current_step = ?, error_code = NULL, error_message = NULL, updated_at = datetime('now')
       WHERE id = ? AND status != 'cancelled'`,
    ).bind(status, status, jobId).run();
  }
}