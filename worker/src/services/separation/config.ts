import type { Env } from '../../env';
import { ContainerDialogueSeparationProvider } from './container';
import type { DialogueSeparationProvider } from './types';

export const SEPARATION_PROVIDER = 'demucs-container-htdemucs-8726e21a';
export const SEPARATION_PROVIDER_VERSION = 'demucs@4.0.1;model=htdemucs;digest=sha256:8726e21a';
export const SEPARATION_MODEL_ID = 'htdemucs';
export const SEPARATION_MODEL_DIGEST = 'sha256:8726e21a';
export const SEPARATION_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

function runtimeQualified(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function createDialogueSeparationProvider(
  env: Pick<Env, 'SEPARATOR_CONTAINER' | 'SEPARATION_RUNTIME_QUALIFIED'>,
): DialogueSeparationProvider {
  return new ContainerDialogueSeparationProvider(env.SEPARATOR_CONTAINER, {
    provider: SEPARATION_PROVIDER,
    providerVersion: SEPARATION_PROVIDER_VERSION,
    modelId: SEPARATION_MODEL_ID,
    modelDigest: SEPARATION_MODEL_DIGEST,
    qualification: runtimeQualified(env.SEPARATION_RUNTIME_QUALIFIED) ? 'qualified' : 'unqualified',
    maxDurationMs: SEPARATION_MAX_DURATION_MS,
  });
}
