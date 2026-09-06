import { Hono } from 'hono';
import type { Env } from '../env';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { ProjectExportRepository } from '../db/project-exports';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { ShareRepository, type ShareStore } from '../db/shares';
import { errorBody } from '../http/json';
import { MediaObjectNotFoundError, streamMediaObject } from '../http/media-stream';
import { createTelemetry, emitTelemetry, type TelemetrySink } from '../observability/telemetry';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';
import { createShareToken, hashShareToken } from '../security/share-token';

const CANONICAL_SHARE_ORIGIN = 'https://yupvox.qs3d.site';
const DEFAULT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_SHARE_TTL_SECONDS = 60 * 60;
const MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ProjectExportStore = Pick<ProjectExportRepository, 'get' | 'latestCompleted'>;

export type ProjectShareRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeShares?: (env: Env) => ShareStore;
  makeExports?: (env: Env) => ProjectExportStore;
  createToken?: typeof createShareToken;
  now?: () => Date;
};

export type PublicShareRouteDeps = {
  makeShares?: (env: Env) => ShareStore;
  makeBucket?: (env: Env) => R2ReadableBucketLike;
  makeTelemetry?: (env: Env) => TelemetrySink;
  hashToken?: typeof hashShareToken;
  now?: () => Date;
};

function parseShareTtl(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_SHARE_TTL_SECONDS;
  if (!Number.isInteger(value)) return null;
  const seconds = Number(value);
  if (seconds < MIN_SHARE_TTL_SECONDS || seconds > MAX_SHARE_TTL_SECONDS) return null;
  return seconds;
}

async function readCreateBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readableBucket(env: Env): R2ReadableBucketLike {
  return {
    async head(key) {
      if (!env.MEDIA.head) return null;
      return env.MEDIA.head(key);
    },
    async get(key, options) {
      if (!env.MEDIA.get) return null;
      return env.MEDIA.get(key, options);
    },
  };
}

function noReferrer(response: Response): Response {
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export function createProjectShareRoutes(deps: ProjectShareRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeShares = deps.makeShares ?? ((env: Env) => new ShareRepository(env.DB));
  const makeExports = deps.makeExports ?? ((env: Env) => new ProjectExportRepository(env.DB));
  const makeToken = deps.createToken ?? createShareToken;
  const now = deps.now ?? (() => new Date());

  routes.post('/:id/shares', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const body = await readCreateBody(c.req.raw);
    if (!body) return c.json(errorBody('INVALID_JSON', 'Request body must be a JSON object.'), 400);
    const ttlSeconds = parseShareTtl(body.expiresInSeconds);
    if (ttlSeconds === null) {
      return c.json(
        errorBody(
          'SHARE_TTL_INVALID',
          `Share expiry must be an integer between ${MIN_SHARE_TTL_SECONDS} and ${MAX_SHARE_TTL_SECONDS} seconds.`,
        ),
        400,
      );
    }

    if (body.exportId !== undefined && (typeof body.exportId !== 'string' || !body.exportId.trim())) {
      return c.json(errorBody('EXPORT_ID_INVALID', 'Export id must be a non-empty string.'), 400);
    }
    const requestedExportId = typeof body.exportId === 'string' ? body.exportId.trim() : null;

    let resolvedExportId: string | null = null;
    let exportObjectKey: string | null = null;
    const exportsStore = makeExports(c.env);

    if (requestedExportId) {
      const attempt = await exportsStore.get(projectId, requestedExportId, userId);
      if (!attempt) return c.json(errorBody('EXPORT_NOT_FOUND', 'Export not found.'), 404);
      const objectKey = attempt.output === 'subtitles' ? attempt.subtitleObjectKey : attempt.exportObjectKey;
      if (attempt.status !== 'completed' || !objectKey) {
        return c.json(errorBody('EXPORT_NOT_READY', 'Selected export is not ready to share.'), 409);
      }
      resolvedExportId = attempt.id;
      exportObjectKey = objectKey;
    } else {
      let latestVietnamese = null;
      try {
        latestVietnamese = await exportsStore.latestCompleted(projectId, userId, 'vi', 'dubbed');
      } catch {
        // Legacy callers can still share an already-published project-level Vietnamese artifact
        // while a pre-0010 database is being reconciled.
      }

      if (project.exportObjectKey) {
        exportObjectKey = project.exportObjectKey;
        if (latestVietnamese?.exportObjectKey === project.exportObjectKey) resolvedExportId = latestVietnamese.id;
      } else if (latestVietnamese?.exportObjectKey) {
        exportObjectKey = latestVietnamese.exportObjectKey;
        resolvedExportId = latestVietnamese.id;
      }

      if (!exportObjectKey) {
        return c.json(errorBody('EXPORT_NOT_READY', 'Final Vietnamese export is not ready to share.'), 409);
      }
    }

    const createdAt = now();
    const secret = await makeToken();
    const share = await makeShares(c.env).create({
      projectId,
      userId,
      exportId: resolvedExportId,
      tokenHash: secret.tokenHash,
      tokenHint: secret.tokenHint,
      exportObjectKey,
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString(),
    });
    const shareUrl = `${CANONICAL_SHARE_ORIGIN}/api/shares/${encodeURIComponent(share.id)}/media?token=${encodeURIComponent(secret.token)}`;
    return c.json({ share, shareUrl }, 201);
  });

  routes.get('/:id/shares', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    return c.json(await makeShares(c.env).listForProject(projectId, userId, now()));
  });

  routes.delete('/:id/shares/:shareId', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    const share = await makeShares(c.env).revoke(projectId, c.req.param('shareId'), userId, now());
    if (!share) return c.json(errorBody('SHARE_NOT_FOUND', 'Share not found.'), 404);
    return c.json(share);
  });

  return routes;
}

export function createPublicShareRoutes(deps: PublicShareRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeShares = deps.makeShares ?? ((env: Env) => new ShareRepository(env.DB));
  const makeBucket = deps.makeBucket ?? readableBucket;
  const makeTelemetry = deps.makeTelemetry ?? createTelemetry;
  const hashToken = deps.hashToken ?? hashShareToken;
  const now = deps.now ?? (() => new Date());

  routes.get('/shares/:shareId/media', async (c) => {
    const shareId = c.req.param('shareId');
    const requestId = c.get('requestId');
    const telemetry = makeTelemetry(c.env);
    const rawToken = c.req.query('token')?.trim() ?? '';

    const notFound = () => {
      emitTelemetry(telemetry, {
        name: 'share_access',
        requestId,
        shareId,
        accessMode: 'share',
        httpStatus: 404,
        status: 'not_found',
      });
      return noReferrer(c.json(errorBody('SHARE_NOT_FOUND', 'Share not found.'), 404));
    };

    if (!rawToken) return notFound();

    const tokenHash = await hashToken(rawToken);
    const share = await makeShares(c.env).resolveActive(shareId, tokenHash, now());
    if (!share) return notFound();

    try {
      const response = await streamMediaObject(
        makeBucket(c.env),
        share.exportObjectKey,
        c.req.raw,
        share.exportObjectKey.endsWith('.srt') ? `${share.projectId}-subtitles.srt` : `${share.projectId}-dubbed.mp4`,
      );
      const rangeRequest = Boolean(c.req.header('range'));
      const success = response.status === 200 || response.status === 206;
      emitTelemetry(telemetry, {
        name: 'share_access',
        requestId,
        shareId: share.id,
        projectId: share.projectId,
        accessMode: 'share',
        httpStatus: response.status,
        rangeRequest,
        status: success ? 'success' : 'rejected',
      });
      if (success) {
        emitTelemetry(telemetry, {
          name: 'export_download',
          requestId,
          shareId: share.id,
          projectId: share.projectId,
          accessMode: 'share',
          httpStatus: response.status,
          rangeRequest,
          status: 'success',
        });
      }
      return noReferrer(response);
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) return notFound();
      throw error;
    }
  });

  return routes;
}
