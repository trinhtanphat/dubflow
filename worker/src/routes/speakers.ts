import { Hono } from 'hono';
import type { Env } from '../env';
import { errorBody } from '../http/json';
import { getCurrentUserId } from '../security/current-user';
import { MultilangRepository } from '../db/multilang';
import {
  SpeakerPersistenceError,
  SpeakerRepository,
  type SpeakerPatch,
  type SpeakerStore,
} from '../db/speakers';

export type SpeakerStoreFactory = (env: Env) => SpeakerStore;

function normalizePatch(value: unknown): SpeakerPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpeakerPersistenceError('SPEAKER_PATCH_INVALID', 'Speaker patch must be an object.');
  }
  const input = value as Record<string, unknown>;
  const patch: SpeakerPatch = {};

  if ('displayName' in input) {
    if (typeof input.displayName !== 'string') {
      throw new SpeakerPersistenceError('DISPLAY_NAME_INVALID', 'Display name must be text.');
    }
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 80) {
      throw new SpeakerPersistenceError('DISPLAY_NAME_INVALID', 'Display name must contain 1 to 80 characters.');
    }
    patch.displayName = displayName;
  }

  if ('voiceId' in input) {
    if (input.voiceId === null) {
      patch.voiceId = null;
    } else if (typeof input.voiceId === 'string') {
      const voiceId = input.voiceId.trim();
      if (!voiceId || voiceId.length > 200) {
        throw new SpeakerPersistenceError('VOICE_ID_INVALID', 'Voice id must contain 1 to 200 characters, or null to clear it.');
      }
      patch.voiceId = voiceId;
    } else {
      throw new SpeakerPersistenceError('VOICE_ID_INVALID', 'Voice id must be text or null.');
    }
  }

  if (patch.displayName === undefined && patch.voiceId === undefined) {
    throw new SpeakerPersistenceError('SPEAKER_PATCH_EMPTY', 'Speaker patch must change displayName or voiceId.');
  }
  return patch;
}

function statusFor(error: SpeakerPersistenceError): 400 | 404 | 409 {
  if (error.code === 'PROJECT_NOT_FOUND') return 404;
  if (error.code === 'PROJECT_BUSY') return 409;
  return 400;
}

export function createSpeakerRoutes(
  makeStore: SpeakerStoreFactory = (env) => new SpeakerRepository(env.DB, new MultilangRepository(env.DB)),
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/:id/speakers', async (c) => {
    const speakers = await makeStore(c.env).list(c.req.param('id'), getCurrentUserId());
    return c.json(speakers);
  });

  routes.patch('/:id/speakers/:speakerId', async (c) => {
    try {
      const patch = normalizePatch(await c.req.json());
      const speaker = await makeStore(c.env).update(
        c.req.param('id'),
        c.req.param('speakerId'),
        getCurrentUserId(),
        patch,
      );
      return speaker
        ? c.json(speaker)
        : c.json(errorBody('SPEAKER_NOT_FOUND', 'Speaker not found.'), 404);
    } catch (error) {
      if (error instanceof SpeakerPersistenceError) {
        return c.json(errorBody(error.code, error.message), statusFor(error));
      }
      return c.json(errorBody('SPEAKER_UPDATE_FAILED', 'Unable to update speaker.'), 500);
    }
  });

  return routes;
}
