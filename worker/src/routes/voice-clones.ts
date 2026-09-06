import { Hono } from 'hono';
import type { Env } from '../env';
import { errorBody } from '../http/json';
import { createTelemetry, withProviderTelemetry } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { enforceRateLimit } from '../security/rate-limit';
import { SpeakerRepository } from '../db/speakers';
import {
  VoiceClonePersistenceError,
  VoiceCloneRepository,
  type VoiceClone,
  type VoiceCloneStore,
} from '../db/voice-clones';
import { ElevenLabsVoiceCloneProvider } from '../services/voice-clone/elevenlabs';
import {
  VOICE_CLONE_CONSENT_VERSION,
  enrollVoiceClone,
  validateVoiceCloneSample,
  voiceCloneSampleKey,
} from '../services/voice-clone/enrollment';
import { VoiceCloneEnrollmentError, VoiceCloneProviderError, type VoiceCloneProvider } from '../services/voice-clone/types';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class VoiceCloneRouteError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 404 | 409 | 500 | 502 | 503 = 400) {
    super(message);
    this.name = 'VoiceCloneRouteError';
  }
}

export function parseVoiceCloneCreatePayload(value: unknown): { name: string; consentVersion: string } {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) {
    throw new VoiceCloneRouteError('VOICE_CLONE_NAME_INVALID', 'Voice clone name must contain 1 to 80 characters.');
  }
  if (input.consentAcknowledged !== true || input.consentVersion !== VOICE_CLONE_CONSENT_VERSION) {
    throw new VoiceCloneRouteError('VOICE_CLONE_CONSENT_REQUIRED', 'Current voice clone consent and rights acknowledgement is required.');
  }
  return { name, consentVersion: VOICE_CLONE_CONSENT_VERSION };
}

export function assertVoiceCloneAssignable(clone: Pick<VoiceClone, 'status' | 'providerVoiceId'>): void {
  if (clone.status !== 'ready' || !clone.providerVoiceId) {
    throw new VoiceCloneRouteError('VOICE_CLONE_STATE_CONFLICT', 'Voice clone must be ready before assignment.', 409);
  }
}

function assertCloneCanAcceptSample(clone: VoiceClone): void {
  if ((clone.status !== 'creating' && clone.status !== 'failed') || clone.providerVoiceId) {
    throw new VoiceCloneRouteError('VOICE_CLONE_STATE_CONFLICT', 'Voice clone is not accepting enrollment samples.', 409);
  }
}

function providerConfigured(env: Env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY?.trim());
}

function routeError(error: unknown): { code: string; message: string; status: 400 | 404 | 409 | 500 | 502 | 503 } {
  if (error instanceof VoiceCloneRouteError) return error;
  if (error instanceof VoiceClonePersistenceError) {
    if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'VOICE_CLONE_NOT_FOUND') {
      return { code: 'VOICE_CLONE_NOT_FOUND', message: 'Voice clone not found.', status: 404 };
    }
    return { code: error.code, message: error.message, status: 500 };
  }
  if (error instanceof VoiceCloneProviderError) {
    return { code: error.code, message: error.message, status: error.code === 'VOICE_CLONE_PROVIDER_UNCONFIGURED' ? 503 : 502 };
  }
  if (error instanceof VoiceCloneEnrollmentError) {
    const status = error.code === 'VOICE_CLONE_SAMPLE_INVALID' ? 400 : 502;
    return { code: error.code, message: error.message, status };
  }
  return { code: 'VOICE_CLONE_PROVIDER_FAILED', message: 'Voice clone operation failed.', status: 500 };
}

export function createVoiceCloneRoutes(
  makeStore: (env: Env) => VoiceCloneStore = (env) => new VoiceCloneRepository(env.DB),
  makeProvider: (env: Env, fetcher: FetchLike) => VoiceCloneProvider = (env, fetcher) => new ElevenLabsVoiceCloneProvider(env.ELEVENLABS_API_KEY ?? '', fetcher),
  fetcher: FetchLike = fetch,
) {
  const routes = new Hono<WorkerHonoEnv>();

  routes.get('/:id/voice-clones', async (c) => {
    const userId = getCurrentUserId();
    const clones = await makeStore(c.env).list(c.req.param('id'), userId);
    return c.json(clones);
  });

  routes.post('/:id/voice-clones', async (c) => {
    try {
      const userId = getCurrentUserId();
      const payload = parseVoiceCloneCreatePayload(await c.req.json());
      const clone = await makeStore(c.env).create(c.req.param('id'), userId, payload.name, payload.consentVersion);
      return c.json(clone, 201);
    } catch (error) {
      const safe = routeError(error);
      return c.json(errorBody(safe.code, safe.message), safe.status);
    }
  });

  routes.post('/:id/voice-clones/:cloneId/sample', async (c) => {
    try {
      const projectId = c.req.param('id');
      const cloneId = c.req.param('cloneId');
      const userId = getCurrentUserId();
      const store = makeStore(c.env);
      const clone = await store.get(projectId, cloneId, userId);
      if (!clone) throw new VoiceCloneRouteError('VOICE_CLONE_NOT_FOUND', 'Voice clone not found.', 404);
      if (clone.consentVersion !== VOICE_CLONE_CONSENT_VERSION) {
        throw new VoiceCloneRouteError('VOICE_CLONE_CONSENT_REQUIRED', 'Current voice clone consent is required.');
      }
      assertCloneCanAcceptSample(clone);
      const bytes = await c.req.arrayBuffer();
      const contentType = c.req.header('content-type');
      validateVoiceCloneSample(bytes.byteLength, contentType);
      if (!c.env.MEDIA.put) throw new VoiceCloneRouteError('VOICE_CLONE_SAMPLE_INVALID', 'Voice clone sample storage is unavailable.', 503);
      const key = voiceCloneSampleKey(projectId, cloneId);
      await c.env.MEDIA.put(key, new Blob([bytes], { type: contentType }));
      return c.json({ cloneId, uploaded: true, size: bytes.byteLength });
    } catch (error) {
      const safe = routeError(error);
      return c.json(errorBody(safe.code, safe.message), safe.status);
    }
  });

  routes.post('/:id/voice-clones/:cloneId/enroll', async (c) => {
    try {
      const projectId = c.req.param('id');
      const cloneId = c.req.param('cloneId');
      const userId = getCurrentUserId();
      const store = makeStore(c.env);
      const clone = await store.get(projectId, cloneId, userId);
      if (!clone) throw new VoiceCloneRouteError('VOICE_CLONE_NOT_FOUND', 'Voice clone not found.', 404);
      if (clone.consentVersion !== VOICE_CLONE_CONSENT_VERSION) {
        throw new VoiceCloneRouteError('VOICE_CLONE_CONSENT_REQUIRED', 'Current voice clone consent is required.');
      }
      assertCloneCanAcceptSample(clone);
      if (!providerConfigured(c.env)) {
        throw new VoiceCloneRouteError('VOICE_CLONE_PROVIDER_UNCONFIGURED', 'Voice clone provider is not configured.', 503);
      }
      if (!c.env.MEDIA.get) throw new VoiceCloneRouteError('VOICE_CLONE_SAMPLE_REQUIRED', 'Voice clone sample is required.');
      const sampleKey = voiceCloneSampleKey(projectId, cloneId);
      const sample = await c.env.MEDIA.get(sampleKey);
      if (!sample) throw new VoiceCloneRouteError('VOICE_CLONE_SAMPLE_REQUIRED', 'Voice clone sample is required.');
      validateVoiceCloneSample(sample.size, sample.httpMetadata?.contentType);

      const rateLimited = await enforceRateLimit(c, 'voice-clone', userId, projectId);
      if (rateLimited) return rateLimited;

      const result = await withProviderTelemetry(createTelemetry(c.env), {
        requestId: c.get('requestId'),
        actorId: userId,
        projectId,
        operation: 'voice-clone-enroll',
        provider: 'elevenlabs',
        errorCode: 'VOICE_CLONE_PROVIDER_FAILED',
      }, () => enrollVoiceClone({
        clone,
        userId,
        store,
        bucket: c.env.MEDIA,
        sample,
        sampleKey,
        provider: makeProvider(c.env, fetcher),
      }));
      return c.json(result);
    } catch (error) {
      const safe = routeError(error);
      return c.json(errorBody(safe.code, safe.message), safe.status);
    }
  });

  routes.post('/:id/speakers/:speakerId/voice-clone/:cloneId', async (c) => {
    try {
      const projectId = c.req.param('id');
      const userId = getCurrentUserId();
      const clone = await makeStore(c.env).get(projectId, c.req.param('cloneId'), userId);
      if (!clone) throw new VoiceCloneRouteError('VOICE_CLONE_NOT_FOUND', 'Voice clone not found.', 404);
      assertVoiceCloneAssignable(clone);
      const speaker = await new SpeakerRepository(c.env.DB).update(projectId, c.req.param('speakerId'), userId, {
        voiceId: clone.providerVoiceId,
      });
      if (!speaker) throw new VoiceCloneRouteError('SPEAKER_NOT_FOUND', 'Speaker not found.', 404);
      return c.json({ clone, speaker });
    } catch (error) {
      const safe = routeError(error);
      return c.json(errorBody(safe.code, safe.message), safe.status);
    }
  });

  routes.delete('/:id/voice-clones/:cloneId', async (c) => {
    try {
      const projectId = c.req.param('id');
      const cloneId = c.req.param('cloneId');
      const userId = getCurrentUserId();
      const store = makeStore(c.env);
      const clone = await store.get(projectId, cloneId, userId);
      if (!clone) throw new VoiceCloneRouteError('VOICE_CLONE_NOT_FOUND', 'Voice clone not found.', 404);
      if (clone.status === 'deleted') return c.json(clone);

      await store.markDeleting(projectId, cloneId, userId);
      if (clone.providerVoiceId) {
        const speakers = await new SpeakerRepository(c.env.DB).list(projectId, userId);
        for (const speaker of speakers) {
          if (speaker.voiceProvider === 'elevenlabs' && speaker.voiceId === clone.providerVoiceId) {
            await new SpeakerRepository(c.env.DB).update(projectId, speaker.id, userId, { voiceId: null });
          }
        }
        try {
          await withProviderTelemetry(createTelemetry(c.env), {
            requestId: c.get('requestId'),
            actorId: userId,
            projectId,
            operation: 'voice-clone-delete',
            provider: 'elevenlabs',
            errorCode: 'VOICE_CLONE_DELETE_FAILED',
          }, () => makeProvider(c.env, fetcher).deleteClone(clone.providerVoiceId!));
        } catch {
          await store.markFailed(projectId, cloneId, userId, 'VOICE_CLONE_DELETE_FAILED');
          throw new VoiceCloneRouteError('VOICE_CLONE_DELETE_FAILED', 'Voice clone provider deletion failed.', 502);
        }
      }

      const key = voiceCloneSampleKey(projectId, cloneId);
      await c.env.MEDIA.delete?.(key).catch(() => undefined);
      return c.json(await store.markDeleted(projectId, cloneId, userId));
    } catch (error) {
      const safe = routeError(error);
      return c.json(errorBody(safe.code, safe.message), safe.status);
    }
  });

  return routes;
}
