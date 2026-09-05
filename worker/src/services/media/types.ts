export type AudioChunk = {
  objectKey: string;
  offsetMs: number;
  durationMs: number;
};

export interface MediaProcessor {
  probe(objectKey: string): Promise<{ durationMs: number }>;
  extractAudioChunks(projectId: string, objectKey: string): Promise<AudioChunk[]>;
  renderExport(projectId: string): Promise<{ exportObjectKey: string }>;
}
