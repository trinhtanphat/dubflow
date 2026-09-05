export interface MediaProcessor {
  probe(objectKey: string): Promise<{ durationMs: number }>;
  extractAudio(objectKey: string): Promise<{ audioObjectKey: string }>;
  renderExport(projectId: string): Promise<{ exportObjectKey: string }>;
}
