import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { SegmentRepository } from '../db/segments';
import {
  SegmentTranslationPersistenceError,
  SegmentTranslationRepository,
} from '../db/segment-translations';
import { errorBody } from '../http/json';
import { getCurrentUserId } from '../security/current-user';
import { targetVoiceObjectKey } from '../services/voice/object-key';

const CLIENT_PCM_SAMPLE_RATE = 24_000;
const CLIENT_PCM_CHANNELS = 1;
const CLIENT_PCM_MAX_BYTES = 8 * 1024 * 1024;
const CLIENT_PCM_FORMAT = 's16le';

type ClientVoiceRepositories = {
  projects: Pick<ProjectRepository, 'getByIdForUser'>;
  segments: Pick<SegmentRepository, 'get'>;
  translations: Pick<SegmentTranslationRepository, 'get' | 'setVoiceResultForVersion'>;
};

export type ClientVoiceRouteDeps = {
  makeRepositories?: (env: Env) => ClientVoiceRepositories;
};

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function contentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function repositoryError(error: unknown) {
  if (error instanceof SegmentTranslationPersistenceError) {
    const status = error.code === 'TRANSLATION_VARIANT_CONFLICT' ? 409 : 404;
    return { status, body: errorBody(error.code, error.message) } as const;
  }
  return { status: 500, body: errorBody('CLIENT_VOICE_UPLOAD_FAILED', 'Client voice upload failed.') } as const;
}

export function createClientVoiceRoutes(deps: ClientVoiceRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeRepositories = deps.makeRepositories ?? ((env: Env): ClientVoiceRepositories => ({
    projects: new ProjectRepository(env.DB),
    segments: new SegmentRepository(env.DB),
    translations: new SegmentTranslationRepository(env.DB),
  }));

  routes.put('/:id/translations/:language/:segmentId/voice-pcm', async (c) => {
    const projectId = c.req.param('id');
    const targetLanguage = c.req.param('language');
    const segmentId = c.req.param('segmentId');
    const userId = getCurrentUserId();

    if (targetLanguage !== 'vi') {
      return c.json(errorBody(
        'CLIENT_VOICE_LANGUAGE_UNSUPPORTED',
        'Client-generated voice is currently qualified only for Vietnamese.',
      ), 400);
    }

    const mediaType = (c.req.header('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const format = (c.req.header('X-DubFlow-PCM-Format') ?? '').trim().toLowerCase();
    const sampleRate = positiveInteger(c.req.header('X-DubFlow-PCM-Sample-Rate'));
    const channels = positiveInteger(c.req.header('X-DubFlow-PCM-Channels'));
    const expectedVersion = positiveInteger(c.req.header('X-DubFlow-Translation-Version'));
    if (
      mediaType !== 'application/octet-stream'
      || format !== CLIENT_PCM_FORMAT
      || sampleRate !== CLIENT_PCM_SAMPLE_RATE
      || channels !== CLIENT_PCM_CHANNELS
      || expectedVersion === null
    ) {
      return c.json(errorBody(
        'CLIENT_VOICE_PCM_INVALID',
        'Client voice must be application/octet-stream s16le mono PCM at 24000 Hz with a positive translation version.',
      ), 400);
    }

    const declaredLength = contentLength(c.req.header('content-length'));
    if (declaredLength !== null && (declaredLength < 0 || declaredLength > CLIENT_PCM_MAX_BYTES)) {
      return c.json(errorBody('CLIENT_VOICE_PCM_TOO_LARGE', 'Client PCM upload exceeds the 8 MiB limit.'), 413);
    }

    try {
      const repositories = makeRepositories(c.env);
      const project = await repositories.projects.getByIdForUser(projectId, userId);
      if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

      const segment = await repositories.segments.get(projectId, segmentId, userId);
      if (!segment) return c.json(errorBody('SEGMENT_NOT_FOUND', 'Segment not found.'), 404);

      const translation = await repositories.translations.get(projectId, segmentId, userId, 'vi');
      if (!translation) return c.json(errorBody('TRANSLATION_VARIANT_NOT_FOUND', 'Translation variant not found.'), 404);
      if (translation.translationStatus !== 'completed' || !translation.translatedText.trim()) {
        return c.json(errorBody(
          'TRANSLATION_VARIANT_INCOMPLETE',
          'A completed non-empty Vietnamese translation is required before uploading client voice.',
        ), 409);
      }
      if (translation.version !== expectedVersion) {
        return c.json(errorBody(
          'TRANSLATION_VARIANT_CONFLICT',
          'Translation variant changed on the server.',
        ), 409);
      }

      const audio = await c.req.raw.arrayBuffer();
      if (audio.byteLength === 0 || audio.byteLength % 2 !== 0) {
        return c.json(errorBody(
          'CLIENT_VOICE_PCM_INVALID',
          'Client PCM must contain a non-empty even number of bytes for signed 16-bit audio.',
        ), 400);
      }
      if (audio.byteLength > CLIENT_PCM_MAX_BYTES) {
        return c.json(errorBody('CLIENT_VOICE_PCM_TOO_LARGE', 'Client PCM upload exceeds the 8 MiB limit.'), 413);
      }
      if (!c.env.MEDIA.put) {
        return c.json(errorBody('CLIENT_VOICE_STORAGE_UNAVAILABLE', 'R2 voice storage is unavailable.'), 503);
      }

      const objectKey = targetVoiceObjectKey(projectId, 'vi', segmentId, expectedVersion);
      await c.env.MEDIA.put(objectKey, audio, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      const persisted = await repositories.translations.setVoiceResultForVersion(
        projectId,
        segmentId,
        userId,
        'vi',
        expectedVersion,
        objectKey,
      );

      return c.json({
        targetLanguage: 'vi',
        segmentId,
        version: persisted.version,
        voiceStatus: persisted.voiceStatus,
        objectKey: persisted.dubbedObjectKey,
      });
    } catch (error) {
      const result = repositoryError(error);
      return c.json(result.body, result.status);
    }
  });

  return routes;
}
