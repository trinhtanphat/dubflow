import type { TargetLanguage } from '../../domain/language';
import type { DubbedAudioMode } from '../../domain/audio-mode';

export type AudioChunk = {
  objectKey: string;
  offsetMs: number;
  durationMs: number;
  overlapBeforeMs: number;
  overlapAfterMs: number;
};

export type ExportClip = {
  segmentId: string;
  startMs: number;
  endMs: number;
  objectKey: string;
};

export type RenderExportOptions = {
  targetLanguage: TargetLanguage;
  exportId: string;
  audioMode?: DubbedAudioMode;
  backgroundObjectKey?: string;
};

export interface MediaProcessor {
  probe(objectKey: string): Promise<{ durationMs: number }>;
  extractAudioChunks(projectId: string, objectKey: string): Promise<AudioChunk[]>;
  extractExportAudio(
    projectId: string,
    exportObjectKey: string,
    targetLanguage: TargetLanguage,
    exportId: string,
  ): Promise<{ audioObjectKey: string }>;
  renderExport(
    projectId: string,
    objectKey: string,
    clips: ExportClip[],
    options?: RenderExportOptions,
  ): Promise<{ exportObjectKey: string }>;
}
