import { apiFetch } from '../../lib/api/client';

export const TARGET_LANGUAGES = ['vi', 'en', 'ja', 'ko', 'zh'] as const;
export type TargetLanguage = typeof TARGET_LANGUAGES[number];

export type ExportVariantStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ExportVariant = {
  id: string;
  projectId: string;
  batchId: string;
  targetLanguage: TargetLanguage;
  status: ExportVariantStatus;
  objectKey: string | null;
  jobId: string;
  errorCode: string | null;
  generation: number;
};

export type BatchExportTarget = {
  targetLanguage: TargetLanguage;
  exportId: string;
  jobId: string;
  workflowId?: string;
  status: 'queued' | 'failed';
  errorCode?: string;
};

export type BatchExportResult = {
  status: 'queued';
  batchId: string;
  targets: BatchExportTarget[];
};

export async function fetchProjectTargets(projectId: string): Promise<TargetLanguage[]> {
  const result = await apiFetch<{ targets: TargetLanguage[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/targets`,
  );
  return result.targets;
}

export async function saveProjectTargets(
  projectId: string,
  targetLanguages: TargetLanguage[],
): Promise<TargetLanguage[]> {
  const result = await apiFetch<{ targets: TargetLanguage[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/targets`,
    {
      method: 'PUT',
      body: JSON.stringify({ targetLanguages }),
    },
  );
  return result.targets;
}

export function startBatchExport(projectId: string, targetLanguages: TargetLanguage[]) {
  return apiFetch<BatchExportResult>(
    `/api/projects/${encodeURIComponent(projectId)}/exports/batch`,
    {
      method: 'POST',
      body: JSON.stringify({ targetLanguages }),
    },
  );
}

export function fetchExportVariants(projectId: string) {
  return apiFetch<ExportVariant[]>(`/api/projects/${encodeURIComponent(projectId)}/exports`);
}

export function targetExportMediaHref(projectId: string, exportId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(exportId)}/media`;
}
