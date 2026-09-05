import { apiFetch } from '../../lib/api/client';

export type ProjectSummary = { id: string; title: string; source_language: string; target_language: 'vi'; status: string };

export async function listProjects() {
  return apiFetch<{ projects: ProjectSummary[] }>('/api/projects');
}

export async function createProject(title: string, sourceLanguage: string) {
  return apiFetch<{ project: ProjectSummary }>('/api/projects', { method: 'POST', body: JSON.stringify({ title, sourceLanguage }) });
}
