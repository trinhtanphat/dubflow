import type { TargetLanguage } from '../../domain/language';

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
};

export interface MediaProcessor {
  probe(objectKey: string): Promise<{ durationMs: number }>;
  extractAudioChunks(projectId: string, objectKey: string): Promise<AudioChunk[]>;
  renderExport(
    projectId: string,
    objectKey: string,
    clips: ExportClip[],
    options?: RenderExportOptions,
  ): Promise<{ exportObjectKey: string }>;
}
