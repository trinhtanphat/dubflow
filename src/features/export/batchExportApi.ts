import { apiFetch } from '../../lib/api/client';
import type { TargetLanguage } from '../translation/languageVariantsApi';

export type ExportOutput = 'dubbed' | 'subtitles';

export type ExportLaunchDto = {
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  exportId: string;
  jobId: string;
  workflowId?: string;
  status: 'queued' | 'failed';
  code?: string;
  message?: string;
};

export type BatchExportLaunchDto = {
  batchId: string;
  exports: ExportLaunchDto[];
};

function projectPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

export function startLanguageExport(
  projectId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput,
) {
  return apiFetch<ExportLaunchDto>(
    `${projectPath(projectId)}/exports/${encodeURIComponent(targetLanguage)}`,
    { method: 'POST', body: JSON.stringify({ output }) },
  );
}

export function startBatchExport(
  projectId: string,
  targetLanguages: TargetLanguage[],
  output: ExportOutput,
) {
  return apiFetch<BatchExportLaunchDto>(
    `${projectPath(projectId)}/exports/batch`,
    { method: 'POST', body: JSON.stringify({ targetLanguages, output }) },
  );
}
