import type { R2BucketLike, R2ObjectBodyLike } from '../../cloudflare/r2';
import type { VoiceClone, VoiceCloneStore } from '../../db/voice-clones';
import { VoiceCloneEnrollmentError, VoiceCloneProviderError, type VoiceCloneProvider } from './types';

export const VOICE_CLONE_CONSENT_VERSION = 'voice-clone-consent-v1';
export const MAX_VOICE_CLONE_SAMPLE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_VOICE_CLONE_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
]);

export function voiceCloneSampleKey(projectId: string, cloneId: string): string {
  return `projects/${projectId}/voice-clones/${cloneId}/sample/current`;
}

export function validateVoiceCloneSample(size: number, contentType: string | undefined): void {
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VOICE_CLONE_SAMPLE_BYTES) {
    throw new VoiceCloneEnrollmentError('VOICE_CLONE_SAMPLE_INVALID', 'Voice clone sample must be between 1 byte and 10 MiB.');
  }
  const normalized = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!ALLOWED_VOICE_CLONE_CONTENT_TYPES.has(normalized)) {
    throw new VoiceCloneEnrollmentError('VOICE_CLONE_SAMPLE_INVALID', 'Voice clone sample content type is not supported.');
  }
}

async function toBlob(sample: R2ObjectBodyLike): Promise<Blob> {
  validateVoiceCloneSample(sample.size, sample.httpMetadata?.contentType);
  const body = await new Response(sample.body).arrayBuffer();
  if (body.byteLength !== sample.size) {
    throw new VoiceCloneEnrollmentError('VOICE_CLONE_SAMPLE_INVALID', 'Voice clone sample size changed before enrollment.');
  }
  return new Blob([body], { type: sample.httpMetadata?.contentType ?? 'application/octet-stream' });
}

export async function enrollVoiceClone(input: {
  clone: VoiceClone;
  userId: string;
  store: VoiceCloneStore;
  bucket: R2BucketLike;
  sample: R2ObjectBodyLike;
  sampleKey: string;
  provider: VoiceCloneProvider;
}): Promise<VoiceClone> {
  let primaryError: unknown;
  let result: VoiceClone | null = null;
  let createdProviderVoiceId: string | null = null;
  let providerResultPersisted = false;

  try {
    const sample = await toBlob(input.sample);
    const providerResult = await input.provider.createInstantClone({ name: input.clone.name, sample });
    createdProviderVoiceId = providerResult.providerVoiceId;
    result = await input.store.markProviderResult(
      input.clone.projectId,
      input.clone.id,
      input.userId,
      providerResult.providerVoiceId,
      providerResult.requiresVerification,
    );
    providerResultPersisted = true;
  } catch (error) {
    primaryError = error;

    if (createdProviderVoiceId && !providerResultPersisted) {
      try {
        await input.provider.deleteClone(createdProviderVoiceId);
      } catch {
        // The original persistence failure stays authoritative. The delete attempt is
        // deliberately bounded and never exposes a raw provider response.
      }
    }

    const code = error instanceof VoiceCloneProviderError
      ? error.code
      : error instanceof VoiceCloneEnrollmentError
        ? error.code
        : 'VOICE_CLONE_PROVIDER_FAILED';
    await input.store.markFailed(input.clone.projectId, input.clone.id, input.userId, code).catch(() => undefined);
  } finally {
    try {
      if (!input.bucket.delete) throw new Error('R2 delete unavailable');
      await input.bucket.delete(input.sampleKey);
    } catch {
      await input.store.markFailed(
        input.clone.projectId,
        input.clone.id,
        input.userId,
        'VOICE_CLONE_SAMPLE_CLEANUP_FAILED',
      ).catch(() => undefined);
      throw new VoiceCloneEnrollmentError(
        'VOICE_CLONE_SAMPLE_CLEANUP_FAILED',
        'Temporary voice clone sample cleanup failed.',
      );
    }
  }

  if (primaryError) {
    if (primaryError instanceof VoiceCloneEnrollmentError || primaryError instanceof VoiceCloneProviderError) {
      throw primaryError;
    }
    throw new VoiceCloneEnrollmentError('VOICE_CLONE_PROVIDER_FAILED', 'Voice clone enrollment failed.');
  }
  if (!result) throw new VoiceCloneEnrollmentError('VOICE_CLONE_PROVIDER_FAILED', 'Voice clone enrollment failed.');
  return result;
}
