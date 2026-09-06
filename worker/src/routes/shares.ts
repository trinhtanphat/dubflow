import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { ShareRepository, type ShareStore } from '../db/shares';
import { errorBody } from '../http/json';
import { getCurrentUserId } from '../security/current-user';
import { createShareToken } from '../security/share-token';

const DEFAULT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_SHARE_TTL_SECONDS = 60 * 60;
const MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ProjectShareRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeShares?: (env: Env) => ShareStore;
  createToken?: typeof createShareToken;
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

export function createProjectShareRoutes(deps: ProjectShareRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeShares = deps.makeShares ?? ((env: Env) => new ShareRepository(env.DB));
  const makeToken = deps.createToken ?? createShareToken;
  const now = deps.now ?? (() => new Date());

  routes.post('/:id/shares', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    if (!project.exportObjectKey) {
      return c.json(errorBody('EXPORT_NOT_READY', 'Final export is not ready to share.'), 409);
    }

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

    const createdAt = now();
    const secret = await makeToken();
    const share = await makeShares(c.env).create({
      projectId,
      userId,
      tokenHash: secret.tokenHash,
      tokenHint: secret.tokenHint,
      exportObjectKey: project.exportObjectKey,
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString(),
    });
    const origin = new URL(c.req.url).origin;
    const shareUrl = `${origin}/api/shares/${encodeURIComponent(share.id)}/media?token=${encodeURIComponent(secret.token)}`;
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
