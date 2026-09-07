import { describe, expect, it } from 'vitest';
import type { ExportAttemptDto, ExportLaunchDto } from '../features/export/batchExportApi';
import { acceptPolledExportAttempt, isTerminalExportAttempt } from './StudioShell';

const launch: ExportLaunchDto = {
  targetLanguage: 'vi',
  output: 'dubbed',
  exportId: 'e-current',
  jobId: 'j-current',
  status: 'queued',
  visualMode: 'lip_sync',
};

function attempt(overrides: Partial<ExportAttemptDto> = {}): ExportAttemptDto {
  return {
    id: 'e-current',
    projectId: 'p1',
    targetLanguage: 'vi',
    output: 'dubbed',
    batchId: null,
    audioMode: 'dubbed_only',
    status: 'completed',
    exportObjectKey: 'projects/p1/exports/vi/e-current.mp4',
    subtitleObjectKey: null,
    lipSyncRequested: true,
    lipSyncProvider: 'sync-labs',
    lipSyncStatus: 'processing',
    lipSyncObjectKey: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('Phase 4E canonical export polling identity', () => {
  it('accepts only the exact immutable export attempt launched by this Studio result', () => {
    expect(acceptPolledExportAttempt(launch, attempt())).toEqual(attempt());
    expect(acceptPolledExportAttempt(launch, attempt({ id: 'e-newer' }))).toBeNull();
    expect(acceptPolledExportAttempt(launch, attempt({ targetLanguage: 'ja' }))).toBeNull();
    expect(acceptPolledExportAttempt(launch, attempt({ output: 'subtitles' }))).toBeNull();
  });

  it('keeps polling visual work until lip-sync reaches completed or failed', () => {
    expect(isTerminalExportAttempt(launch, attempt({ lipSyncStatus: 'queued' }))).toBe(false);
    expect(isTerminalExportAttempt(launch, attempt({ lipSyncStatus: 'processing' }))).toBe(false);
    expect(isTerminalExportAttempt(launch, attempt({ lipSyncStatus: 'completed' }))).toBe(true);
    expect(isTerminalExportAttempt(launch, attempt({ lipSyncStatus: 'failed' }))).toBe(true);
  });

  it('stops visual polling when the underlying standard export itself failed or was invalidated', () => {
    expect(isTerminalExportAttempt(launch, attempt({ status: 'failed', lipSyncStatus: 'queued' }))).toBe(true);
    expect(isTerminalExportAttempt(launch, attempt({ status: 'invalidated', lipSyncStatus: 'queued' }))).toBe(true);
  });
});