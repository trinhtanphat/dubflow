import type { StemSeparationInput, StemSeparationProvider, StemSeparationResult } from './types';
import { StemSeparationError } from './types';

export interface StemSeparationMedia {
  separateStems(
    projectId: string,
    sourceObjectKey: string,
    sourceRevision: string,
  ): Promise<StemSeparationResult>;
}

function expectedKeys(input: StemSeparationInput): StemSeparationResult {
  const prefix = `projects/${input.projectId}/stems/${input.sourceRevision}`;
  return {
    dialogueObjectKey: `${prefix}/dialogue.wav`,
    backgroundObjectKey: `${prefix}/background.wav`,
  };
}

export class ContainerStemSeparationProvider implements StemSeparationProvider {
  readonly id = 'elevenlabs-two-stems';
  readonly available: boolean;

  constructor(
    private readonly media: StemSeparationMedia | undefined,
    providerAvailable: boolean,
  ) {
    this.available = Boolean(media && providerAvailable);
  }

  async separate(input: StemSeparationInput): Promise<StemSeparationResult> {
    if (!this.available || !this.media) {
      throw new StemSeparationError(
        'STEM_SEPARATION_UNAVAILABLE',
        'Dialogue/background separation is not available for this deployment.',
      );
    }
    const result = await this.media.separateStems(
      input.projectId,
      input.sourceObjectKey,
      input.sourceRevision,
    );
    const expected = expectedKeys(input);
    if (
      result.dialogueObjectKey !== expected.dialogueObjectKey ||
      result.backgroundObjectKey !== expected.backgroundObjectKey
    ) {
      throw new StemSeparationError(
        'STEM_SEPARATION_RESPONSE_INVALID',
        'Stem separation returned non-canonical media objects.',
      );
    }
    return result;
  }
}
