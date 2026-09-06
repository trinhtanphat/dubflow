import { apiFetch } from '../../lib/api/client';
import type { TargetLanguage } from '../translation/languageVariantsApi';

export type ExportOutput = 'dubbed' | 'subtitles';
export type SeparationMode = 'source_mix' | 'preserve_background';

export type ExportCapabilitiesDto = {
  dialogueBackgroundSeparation: {
    available: boolean;
    modes: SeparationMode[];
  };
};

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

function exportBody(output: ExportOutput, separationMode: SeparationMode) {
  return output === 'dubbed' ? { output, separationMode } : { output };
}

export function getExportCapabilities(projectId: string) {
  return apiFetch<ExportCapabilitiesDto>(`${projectPath(projectId)}/export-capabilities`);
}

export function startLanguageExport(
  projectId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput,
  separationMode: SeparationMode = 'source_mix',
) {
  return apiFetch<ExportLaunchDto>(
    `${projectPath(projectId)}/exports/${encodeURIComponent(targetLanguage)}`,
    { method: 'POST', body: JSON.stringify(exportBody(output, separationMode)) },
  );
}

export function startBatchExport(
  projectId: string,
  targetLanguages: TargetLanguage[],
  output: ExportOutput,
  separationMode: SeparationMode = 'source_mix',
) {
  const body = output === 'dubbed'
    ? { targetLanguages, output, separationMode }
    : { targetLanguages, output };
  return apiFetch<BatchExportLaunchDto>(
    `${projectPath(projectId)}/exports/batch`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}
