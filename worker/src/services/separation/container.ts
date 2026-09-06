import type { ContainerNamespaceLike } from '../media/container';
import type {
  AudioSeparationProvider,
  SeparationCapabilities,
  SeparationRequest,
  SeparationResult,
} from './types';

type SeparationIdentity = {
  provider: string;
  modelId: string;
  modelDigest: string;
  qualified?: boolean;
  maxDurationMs?: number;
};

type ProviderErrorCode =
  | 'SEPARATION_REQUEST_INVALID'
  | 'SEPARATION_PROVIDER_FAILED'
  | 'SEPARATION_RESPONSE_INVALID';

export class SeparationProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'SeparationProviderError';
  }
}

function safeSegment(value: string, label: string): string {
  const normalized = value.replace(/:/g, '-');
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(normalized)) {
    throw new SeparationProviderError('SEPARATION_REQUEST_INVALID', `${label} is invalid.`);
  }
  return normalized;
}

function expectedStemKeys(input: SeparationRequest) {
  const provider = safeSegment(input.provider, 'Separation provider');
  const digest = safeSegment(input.modelDigest, 'Separation model digest');
  const prefix = `projects/${input.projectId}/separation/${input.sourceRevision}/${provider}/${digest}`;
  return {
    dialogueObjectKey: `${prefix}/dialogue.wav`,
    backgroundObjectKey: `${prefix}/background.wav`,
  };
}

function assertRequest(input: SeparationRequest, identity: SeparationIdentity): void {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(input.projectId)) {
    throw new SeparationProviderError('SEPARATION_REQUEST_INVALID', 'Project id is invalid.');
  }
  if (!Number.isInteger(input.sourceRevision) || input.sourceRevision <= 0) {
    throw new SeparationProviderError('SEPARATION_REQUEST_INVALID', 'Source revision must be a positive integer.');
  }
  if (!input.sourceObjectKey.startsWith(`projects/${input.projectId}/source/`)) {
    throw new SeparationProviderError('SEPARATION_REQUEST_INVALID', 'Source object key does not belong to the project.');
  }
  if (
    input.provider !== identity.provider ||
    input.modelId !== identity.modelId ||
    input.modelDigest !== identity.modelDigest
  ) {
    throw new SeparationProviderError('SEPARATION_REQUEST_INVALID', 'Separation model identity does not match the configured provider.');
  }
  safeSegment(input.modelId, 'Separation model id');
}

export class ContainerAudioSeparationProvider implements AudioSeparationProvider {
  constructor(
    private readonly namespace: ContainerNamespaceLike,
    private readonly identity: SeparationIdentity,
  ) {}

  async capabilities(): Promise<SeparationCapabilities> {
    return {
      configured: true,
      qualified: this.identity.qualified === true,
      provider: this.identity.provider,
      modelId: this.identity.modelId,
      modelDigest: this.identity.modelDigest,
      ...(this.identity.maxDurationMs === undefined ? {} : { maxDurationMs: this.identity.maxDurationMs }),
    };
  }

  async separate(input: SeparationRequest): Promise<SeparationResult> {
    assertRequest(input, this.identity);
    const expected = expectedStemKeys(input);
    const stub = this.namespace.getByName(input.projectId);
    const response = await stub.fetch(new Request('http://separator.internal/separate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, ...expected }),
    }));

    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new SeparationProviderError(
        'SEPARATION_PROVIDER_FAILED',
        payload.message ?? `Separator container failed (${response.status}).`,
      );
    }

    const payload = await response.json().catch(() => null) as Partial<SeparationResult> | null;
    if (
      payload?.dialogueObjectKey !== expected.dialogueObjectKey ||
      payload.backgroundObjectKey !== expected.backgroundObjectKey ||
      typeof payload.durationMs !== 'number' ||
      !Number.isFinite(payload.durationMs) ||
      payload.durationMs <= 0
    ) {
      throw new SeparationProviderError('SEPARATION_RESPONSE_INVALID', 'Separator container returned invalid artifacts.');
    }

    return {
      dialogueObjectKey: payload.dialogueObjectKey,
      backgroundObjectKey: payload.backgroundObjectKey,
      durationMs: Math.round(payload.durationMs),
    };
  }
}
