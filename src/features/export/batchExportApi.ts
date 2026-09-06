import { apiFetch } from '../../lib/api/client';
import type { TargetLanguage } from '../translation/languageVariantsApi';

export type ExportOutput = 'dubbed' | 'subtitles';
export type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';
export type SeparationQualification = 'qualified' | 'unqualified' | 'unavailable';

export type ExportCapabilitiesDto = {
  duckOriginal: boolean;
  separation: {
    configured: boolean;
    provider: string | null;
    backgroundStem: boolean;
    dialogueStem: boolean;
    qualification: SeparationQualification;
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
  audioMode?: DubbedAudioMode;
};

export type BatchExportLaunchDto = {
  batchId: string;
  exports: ExportLaunchDto[];
};

function projectPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function launchBody(output: ExportOutput, audioMode: DubbedAudioMode) {
  return output === 'dubbed' ? { output, audioMode } : { output };
}

export function fetchExportCapabilities(projectId: string) {
  return apiFetch<ExportCapabilitiesDto>(`${projectPath(projectId)}/export-capabilities`, { method: 'GET' });
}

export function startLanguageExport(
  projectId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput,
  audioMode: DubbedAudioMode = 'dubbed_only',
) {
  return apiFetch<ExportLaunchDto>(
    `${projectPath(projectId)}/exports/${encodeURIComponent(targetLanguage)}`,
    { method: 'POST', body: JSON.stringify(launchBody(output, audioMode)) },
  );
}

export function startBatchExport(
  projectId: string,
  targetLanguages: TargetLanguage[],
  output: ExportOutput,
  audioMode: DubbedAudioMode = 'dubbed_only',
) {
  const body = output === 'dubbed'
    ? { targetLanguages, output, audioMode }
    : { targetLanguages, output };
  return apiFetch<BatchExportLaunchDto>(
    `${projectPath(projectId)}/exports/batch`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}
