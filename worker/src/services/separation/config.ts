import type { Env } from '../../env';
import { ContainerAudioSeparationProvider } from './container';
import type { SeparationCapabilities } from './types';

export const SEPARATION_PROVIDER = 'demucs-container';
export const SEPARATION_MODEL_ID = 'htdemucs';
export const SEPARATION_MODEL_DIGEST = 'sha256:8726e21a';

export function separationCapabilities(
  env: Pick<Env, 'SEPARATION_RUNTIME_QUALIFIED'>,
): SeparationCapabilities {
  return {
    configured: true,
    qualified: env.SEPARATION_RUNTIME_QUALIFIED?.trim().toLowerCase() === 'true',
    provider: SEPARATION_PROVIDER,
    modelId: SEPARATION_MODEL_ID,
    modelDigest: SEPARATION_MODEL_DIGEST,
  };
}

export function createSeparationProvider(
  env: Pick<Env, 'SEPARATOR_CONTAINER' | 'SEPARATION_RUNTIME_QUALIFIED'>,
): ContainerAudioSeparationProvider {
  return new ContainerAudioSeparationProvider(env.SEPARATOR_CONTAINER, separationCapabilities(env));
}
