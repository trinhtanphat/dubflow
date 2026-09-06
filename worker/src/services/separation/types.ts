export type DialogueSeparationCapabilities = {
  configured: boolean;
  provider: string | null;
  backgroundStem: boolean;
  dialogueStem: boolean;
  maxDurationMs?: number;
  supportedContentTypes?: string[];
  qualification: 'qualified' | 'unqualified' | 'unavailable';
};

export type SeparateDialogueInput = {
  projectId: string;
  sourceObjectKey: string;
  sourceGeneration: number;
  durationMs: number;
};

export type SeparationResult = {
  provider: string;
  providerVersion?: string;
  backgroundObjectKey: string;
  dialogueObjectKey?: string | null;
};

export interface DialogueSeparationProvider {
  capabilities(): Promise<DialogueSeparationCapabilities>;
  separate(input: SeparateDialogueInput): Promise<SeparationResult>;
}

export type DialogueSeparationErrorCode =
  | 'DIALOGUE_SEPARATION_UNAVAILABLE'
  | 'DIALOGUE_SEPARATION_UNQUALIFIED'
  | 'DIALOGUE_SEPARATION_FAILED'
  | 'DIALOGUE_SEPARATION_ARTIFACT_INVALID';

export class DialogueSeparationError extends Error {
  constructor(public readonly code: DialogueSeparationErrorCode, message: string) {
    super(message);
    this.name = 'DialogueSeparationError';
  }
}
