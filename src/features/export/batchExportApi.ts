import { apiFetch } from '../../lib/api/client';
import type { TargetLanguage } from '../translation/languageVariantsApi';

export type ExportOutput = 'dubbed' | 'subtitles';
export type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';
export type VisualMode = 'standard' | 'lip_sync';
export type SeparationQualification = 'qualified' | 'unqualified' | 'unavailable';
export type ProjectExportStatus = 'pending' | 'exporting' | 'completed' | 'failed' | 'invalidated';
export type LipSyncStatus = 'not_requested' | 'queued' | 'processing' | 'completed' | 'failed';

export type ExportCapabilitiesDto = {
  duckOriginal: boolean;
  separation: {
    configured: boolean;
    provider: string | null;
    backgroundStem: boolean;
    dialogueStem: boolean;
    qualification: SeparationQualification;
  };
  visualLipSync: {
    available: boolean;
    provider: string | null;
  };
};

export type ExportAttemptDto = {
  id: string;
  projectId: string;
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  batchId: string | null;
  audioMode: DubbedAudioMode;
  status: ProjectExportStatus;
  exportObjectKey: string | null;
  subtitleObjectKey: string | null;
  lipSyncRequested: boolean;
  lipSyncProvider: string | null;
  lipSyncStatus: LipSyncStatus;
  lipSyncObjectKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ExportLaunchDto = {
  targetLanguage: TargetLanguage;
  output: ExportOutput;
  exportId: string;
  jobId: string;
  workflowId?: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  code?: string;
  message?: string;
  audioMode?: DubbedAudioMode;
  visualMode?: VisualMode;
  lipSyncRequested?: boolean;
  lipSyncStatus?: LipSyncStatus;
  exportObjectKey?: string | null;
  lipSyncObjectKey?: string | null;
};

export type BatchExportLaunchDto = {
  batchId: string;
  exports: ExportLaunchDto[];
};

function projectPath(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function launchBody(output: ExportOutput, audioMode: DubbedAudioMode, visualMode: VisualMode) {
  return output === 'dubbed' ? { output, audioMode, visualMode } : { output };
}

export function fetchExportCapabilities(projectId: string) {
  return apiFetch<ExportCapabilitiesDto>(`${projectPath(projectId)}/export-capabilities`, { method: 'GET' });
}

export function fetchLatestLanguageExport(
  projectId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput = 'dubbed',
) {
  return apiFetch<ExportAttemptDto>(
    `${projectPath(projectId)}/exports/${encodeURIComponent(targetLanguage)}?output=${encodeURIComponent(output)}`,
    { method: 'GET' },
  );
}

export function exportMediaUrl(
  projectId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput = 'dubbed',
) {
  return `${projectPath(projectId)}/exports/${encodeURIComponent(targetLanguage)}/media?output=${encodeURIComponent(output)}`;
}

export function startLanguageExport(
  projectId: string,
  targetLanguage: TargetLanguage,
  output: ExportOutput,
  audioMode: DubbedAudioMode = 'dubbed_only',
  visualMode: VisualMode = 'standard',
) {
  return apiFetch<ExportLaunchDto>(
    `${projectPath(projectId)}/exports/${encodeURIComponent(targetLanguage)}`,
    { method: 'POST', body: JSON.stringify(launchBody(output, audioMode, visualMode)) },
  );
}

export function startBatchExport(
  projectId: string,
  targetLanguages: TargetLanguage[],
  output: ExportOutput,
  audioMode: DubbedAudioMode = 'dubbed_only',
  visualMode: VisualMode = 'standard',
) {
  const body = output === 'dubbed'
    ? { targetLanguages, output, audioMode, visualMode }
    : { targetLanguages, output };
  return apiFetch<BatchExportLaunchDto>(
    `${projectPath(projectId)}/exports/batch`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}
