import { apiFetch } from '../../lib/api/client';

export type SeparationLifecycleStatus = 'not_prepared' | 'processing' | 'ready' | 'failed' | 'stale';

export type SeparationStemDto = {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'invalidated';
  sourceGeneration: number;
  provider: string;
  providerVersion: string | null;
  objectKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

export type SeparationJobDto = {
  id: string;
  status: 'queued' | 'running' | 'retrying' | 'failed' | 'completed' | 'cancelled' | 'needs_review';
  progress: number;
  currentStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  updatedAt: string;
};

export type SeparationStateDto = {
  status: SeparationLifecycleStatus;
  qualified: boolean;
  provider: string | null;
  stem: SeparationStemDto | null;
  job: SeparationJobDto | null;
  reused?: boolean;
  workflowId?: string;
};

function path(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/separation`;
}

export function getSeparationStatus(projectId: string) {
  return apiFetch<SeparationStateDto>(path(projectId));
}

export function prepareSeparation(projectId: string, retry = false) {
  return apiFetch<SeparationStateDto>(path(projectId), retry
    ? { method: 'POST', body: JSON.stringify({ retry: true }) }
    : { method: 'POST' });
}
