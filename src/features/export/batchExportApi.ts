import { apiFetch } from '../../lib/api/client';
import type { TargetLanguage } from '../translation/languageVariantsApi';

export type ExportOutput = 'dubbed' | 'subtitles';
export type DubbedMixMode = 'dubbed_only' | 'preserve_background';

export type ExportLaunchDto = {
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  exportId: string;
  jobId: string;
  workflowId?: string;
  status: 'queued' | 'failed';
  mixMode?: DubbedMixMode;
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

function exportBody(output: ExportOutput, mixMode: DubbedMixMode) {
  return output === 'dubbed' ? { output, mixMode } : { output };
}

export function startLanguageExport(
  projectId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput,
  mixMode: DubbedMixMode = 'dubbed_only',
) {
  return apiFetch<ExportLaunchDto>(
    `${projectPath(projectId)}/exports/${encodeURIComponent(targetLanguage)}`,
    { method: 'POST', body: JSON.stringify(exportBody(output, mixMode)) },
  );
}

export function startBatchExport(
  projectId: string,
  targetLanguages: TargetLanguage[],
  output: ExportOutput,
  mixMode: DubbedMixMode = 'dubbed_only',
) {
  const body = output === 'dubbed'
    ? { targetLanguages, output, mixMode }
    : { targetLanguages, output };
  return apiFetch<BatchExportLaunchDto>(
    `${projectPath(projectId)}/exports/batch`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}
