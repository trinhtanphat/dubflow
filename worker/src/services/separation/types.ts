export type SeparationMode = 'source_mix' | 'preserve_background';

export type StemSeparationInput = {
  projectId: string;
  sourceObjectKey: string;
  sourceRevision: string;
};

export type StemSeparationResult = {
  dialogueObjectKey: string;
  backgroundObjectKey: string;
};

export interface StemSeparationProvider {
  readonly id: string;
  readonly available: boolean;
  separate(input: StemSeparationInput): Promise<StemSeparationResult>;
}

export class StemSeparationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'StemSeparationError';
  }
}
