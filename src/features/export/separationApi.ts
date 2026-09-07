import { apiFetch } from '../../lib/api/client';

export type SeparationLifecycleStatus =
  | 'not_prepared'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'invalidated'
  | 'retrying';

export type SeparationDto = {
  id: string;
  status: Exclude<SeparationLifecycleStatus, 'not_prepared' | 'retrying'>;
  sourceRevision: number;
  provider: string;
  modelId: string;
  jobId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type SeparationStateDto = {
  status: SeparationLifecycleStatus;
  qualified: boolean;
  separation: SeparationDto | null;
};

export type SeparationLaunchDto = {
  status: Exclude<SeparationLifecycleStatus, 'not_prepared' | 'invalidated' | 'failed'>;
  reused: boolean;
  jobId?: string;
  workflowId?: string;
  separation: SeparationDto;
};

function separationPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/separation`;
}

export function getSeparationStatus(projectId: string) {
  return apiFetch<SeparationStateDto>(separationPath(projectId));
}

export function prepareSeparation(projectId: string, retry = false) {
  const init: RequestInit = retry
    ? { method: 'POST', body: JSON.stringify({ retry: true }) }
    : { method: 'POST' };
  return apiFetch<SeparationLaunchDto>(separationPath(projectId), init);
}
