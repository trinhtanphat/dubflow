import type { ContainerNamespaceLike } from '../media/container';
import {
  DialogueSeparationError,
  type DialogueSeparationCapabilities,
  type DialogueSeparationProvider,
  type SeparateDialogueInput,
  type SeparationResult,
} from './types';

type ContainerProviderConfig = {
  provider: string;
  providerVersion: string;
  modelId: string;
  modelDigest: string;
  qualification: 'qualified' | 'unqualified';
  maxDurationMs?: number;
};

function assertProjectId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(value)) {
    throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Project id is invalid for separation.');
  }
}

function expectedKeys(input: SeparateDialogueInput, provider: string) {
  const prefix = `projects/${input.projectId}/stems/${input.sourceGeneration}/${provider}`;
  return {
    backgroundObjectKey: `${prefix}/background.wav`,
    dialogueObjectKey: `${prefix}/dialogue.wav`,
  };
}

export class ContainerDialogueSeparationProvider implements DialogueSeparationProvider {
  constructor(
    private readonly namespace: ContainerNamespaceLike | undefined,
    private readonly config: ContainerProviderConfig,
  ) {}

  async capabilities(): Promise<DialogueSeparationCapabilities> {
    return {
      configured: Boolean(this.namespace),
      provider: this.config.provider,
      backgroundStem: true,
      dialogueStem: true,
      qualification: this.config.qualification,
      ...(this.config.maxDurationMs === undefined ? {} : { maxDurationMs: this.config.maxDurationMs }),
    };
  }

  async separate(input: SeparateDialogueInput): Promise<SeparationResult> {
    assertProjectId(input.projectId);
    if (this.config.qualification !== 'qualified') {
      throw new DialogueSeparationError(
        'DIALOGUE_SEPARATION_UNQUALIFIED',
        'Dialogue separation has not been runtime-qualified.',
      );
    }
    if (!this.namespace) {
      throw new DialogueSeparationError('DIALOGUE_SEPARATION_UNAVAILABLE', 'Separator container binding is unavailable.');
    }
    if (!Number.isInteger(input.sourceGeneration) || input.sourceGeneration < 1) {
      throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Source generation is invalid.');
    }
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
      throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Source duration is invalid.');
    }
    if (this.config.maxDurationMs !== undefined && input.durationMs > this.config.maxDurationMs) {
      throw new DialogueSeparationError('DIALOGUE_SEPARATION_UNAVAILABLE', 'Source exceeds separator duration capacity.');
    }
    if (!input.sourceObjectKey.startsWith(`projects/${input.projectId}/`)) {
      throw new DialogueSeparationError('DIALOGUE_SEPARATION_ARTIFACT_INVALID', 'Source object does not belong to the project.');
    }

    const expected = expectedKeys(input, this.config.provider);
    const stub = this.namespace.getByName(`${input.projectId}-${input.sourceGeneration}`);
    const response = await stub.fetch(new Request('http://separator.internal/separate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        provider: this.config.provider,
        providerVersion: this.config.providerVersion,
        modelId: this.config.modelId,
        modelDigest: this.config.modelDigest,
        ...expected,
      }),
    }));
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new DialogueSeparationError(
        'DIALOGUE_SEPARATION_FAILED',
        payload.message ?? `Separator container failed (${response.status}).`,
      );
    }
    const payload = await response.json().catch(() => null) as Partial<SeparationResult> | null;
    if (
      payload?.provider !== this.config.provider
      || payload.providerVersion !== this.config.providerVersion
      || payload.backgroundObjectKey !== expected.backgroundObjectKey
      || payload.dialogueObjectKey !== expected.dialogueObjectKey
    ) {
      throw new DialogueSeparationError(
        'DIALOGUE_SEPARATION_ARTIFACT_INVALID',
        'Separator container returned non-canonical artifacts.',
      );
    }
    return {
      provider: this.config.provider,
      providerVersion: this.config.providerVersion,
      backgroundObjectKey: expected.backgroundObjectKey,
      dialogueObjectKey: expected.dialogueObjectKey,
    };
  }
}
