import { DialogueSeparationError, type DialogueSeparationCapabilities, type DialogueSeparationProvider, type SeparateDialogueInput, type SeparationResult } from './types';

export class UnavailableDialogueSeparationProvider implements DialogueSeparationProvider {
  async capabilities(): Promise<DialogueSeparationCapabilities> {
    return {
      configured: false,
      provider: null,
      backgroundStem: false,
      dialogueStem: false,
      qualification: 'unavailable',
    };
  }

  async separate(_input: SeparateDialogueInput): Promise<SeparationResult> {
    throw new DialogueSeparationError(
      'DIALOGUE_SEPARATION_UNAVAILABLE',
      'Dialogue separation provider is unavailable.',
    );
  }
}
