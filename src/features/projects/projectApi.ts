import { apiFetch } from '../../lib/api/client';

export type CloudProject = {
  id: string;
  userId: string;
  title: string;
  sourceLanguage: 'auto' | 'zh' | 'en' | 'ja' | 'ko';
  targetLanguage: 'vi';
  status: string;
  sourceObjectKey?: string | null;
  sizeBytes?: number | null;
};

export function createProject(title: string, sourceLanguage: CloudProject['sourceLanguage']) {
  return apiFetch<CloudProject>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ title, sourceLanguage, targetLanguage: 'vi' }),
  });
}

export function listProjects() { return apiFetch<CloudProject[]>('/api/projects'); }
