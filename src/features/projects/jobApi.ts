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
};

export type StartProcessingResult = {
  jobId: string;
  workflowId: string;
  status: 'queued';
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
