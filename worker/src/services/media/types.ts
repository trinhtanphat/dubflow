export type AudioChunk = {
  objectKey: string;
  offsetMs: number;
  durationMs: number;
};

export type ExportClip = {
  segmentId: string;
  startMs: number;
  endMs: number;
  objectKey: string;
};

export interface MediaProcessor {
  probe(objectKey: string): Promise<{ durationMs: number }>;
  extractAudioChunks(projectId: string, objectKey: string): Promise<AudioChunk[]>;
  renderExport(projectId: string, objectKey: string, clips: ExportClip[]): Promise<{ exportObjectKey: string }>;
}
