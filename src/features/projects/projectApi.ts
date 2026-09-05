import { apiFetch } from '../../lib/api/client';

export type CloudProjectStatus = 'draft' | 'uploading' | 'ready' | 'processing' | 'needs_review' | 'failed' | 'completed' | 'cancelled';

export type CloudProject = {
  id: string;
  userId: string;
  title: string;
  sourceLanguage: 'auto' | 'zh' | 'en' | 'ja' | 'ko';
  targetLanguage: 'vi';
  status: CloudProjectStatus;
  sourceObjectKey?: string | null;
  durationMs?: number | null;
  sizeBytes?: number | null;
};

export function createProject(title: string, sourceLanguage: CloudProject['sourceLanguage']) {
  return apiFetch<CloudProject>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ title, sourceLanguage, targetLanguage: 'vi' }),
  });
}

export function listProjects() { return apiFetch<CloudProject[]>('/api/projects'); }

export function getProject(projectId: string) {
  return apiFetch<CloudProject>(`/api/projects/${encodeURIComponent(projectId)}`);
}
