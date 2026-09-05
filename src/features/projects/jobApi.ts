import { apiFetch } from '../../lib/api/client';

export type CloudJobStatus = 'queued' | 'running' | 'needs_review' | 'retrying' | 'failed' | 'completed' | 'cancelled';

export type CloudJob = {
  id: string;
  projectId: string;
  type: string;
  status: CloudJobStatus;
  progress: number;
  currentStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type StartProcessingResult = {
  jobId: string;
  workflowId: string;
  status: 'queued';
};

export type RetryJobResult = {
  jobId: string;
  workflowId: string;
  status: 'retrying';
};

export function startProcessing(projectId: string) {
  return apiFetch<StartProcessingResult>(`/api/projects/${encodeURIComponent(projectId)}/process`, { method: 'POST' });
}

export function startExport(projectId: string) {
  return apiFetch<StartProcessingResult>(`/api/projects/${encodeURIComponent(projectId)}/export`, { method: 'POST' });
}

export function getJob(projectId: string, jobId: string) {
  return apiFetch<CloudJob>(`/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`);
}

export function listProjectJobs(projectId: string) {
  return apiFetch<CloudJob[]>(`/api/projects/${encodeURIComponent(projectId)}/jobs`);
}

export function retryProjectJob(projectId: string, jobId: string) {
  return apiFetch<RetryJobResult>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: 'POST' },
  );
}

export function cancelProjectJob(projectId: string, jobId: string) {
  return apiFetch<CloudJob>(
    `/api/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST' },
  );
}
