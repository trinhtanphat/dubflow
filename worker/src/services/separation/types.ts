export type SeparationRequest = {
  projectId: string;
  sourceObjectKey: string;
  sourceRevision: number;
  provider: string;
  modelId: string;
  modelDigest: string;
};

export type SeparationResult = {
  dialogueObjectKey: string;
  backgroundObjectKey: string;
  durationMs: number;
};

export type SeparationCapabilities = {
  configured: boolean;
  qualified: boolean;
  provider: string;
  modelId: string;
  modelDigest: string;
  maxDurationMs?: number;
};

export interface AudioSeparationProvider {
  capabilities(): Promise<SeparationCapabilities>;
  separate(input: SeparationRequest): Promise<SeparationResult>;
}
