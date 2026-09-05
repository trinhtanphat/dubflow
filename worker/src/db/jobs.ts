import type { D1DatabaseLike } from './projects';

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
};

export interface JobStore {
  create(projectId: string, type: string): Promise<DubbingJob>;
  getForProject(projectId: string, jobId: string, userId: string): Promise<DubbingJob | null>;
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
  };
}

const JOB_COLUMNS = `j.id, j.project_id, j.type, j.status, j.progress, j.current_step, j.error_code, j.error_message`;

export class JobRepository implements JobStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async create(projectId: string, type: string): Promise<DubbingJob> {
    const id = crypto.randomUUID();
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
    };
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
      `SELECT id, project_id, type, status, progress, current_step, error_code, error_message
       FROM jobs WHERE id = ? LIMIT 1`,
    ).bind(jobId).first<JobRow>();
    return row ? fromRow(row) : null;
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
       WHERE id = ?`,
    ).bind(errorCode, errorMessage, jobId).run();
  }

  async complete(jobId: string, status: 'completed' | 'needs_review' = 'completed'): Promise<void> {
    await this.db.prepare(
      `UPDATE jobs
       SET status = ?, progress = 1, current_step = ?, error_code = NULL, error_message = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(status, status, jobId).run();
  }
}
