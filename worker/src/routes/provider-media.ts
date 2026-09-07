import { Hono } from 'hono';
import type { Env } from '../env';
import type { R2ReadableBucketLike } from '../cloudflare/r2';
import { ProviderMediaGrantRepository } from '../db/provider-media-grants';
import { errorBody } from '../http/json';
import { MediaObjectNotFoundError, streamMediaObject } from '../http/media-stream';
import { hashProviderMediaToken } from '../security/provider-media-token';

export type ProviderMediaGrantStore = Pick<ProviderMediaGrantRepository, 'resolveActive' | 'markAccessed'>;

export type ProviderMediaRouteDeps = {
  makeGrants?: (env: Env) => ProviderMediaGrantStore;
  makeBucket?: (env: Env) => R2ReadableBucketLike;
  hashToken?: typeof hashProviderMediaToken;
  now?: () => Date;
};

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

function privateNoStore(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export function createProviderMediaRoutes(deps: ProviderMediaRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeGrants = deps.makeGrants ?? ((env: Env) => new ProviderMediaGrantRepository(env.DB));
  const makeBucket = deps.makeBucket ?? readableBucket;
  const hashToken = deps.hashToken ?? hashProviderMediaToken;
  const now = deps.now ?? (() => new Date());

  routes.get('/provider-media/:grantId', async (c) => {
    const notFound = () => privateNoStore(
      c.json(errorBody('PROVIDER_MEDIA_NOT_FOUND', 'Provider media not found.'), 404),
    );

    const rawToken = c.req.query('token')?.trim() ?? '';
    if (!rawToken) return notFound();

    let tokenHash: string;
    try {
      tokenHash = await hashToken(rawToken);
    } catch {
      return notFound();
    }

    const grants = makeGrants(c.env);
    const grant = await grants.resolveActive(c.req.param('grantId'), tokenHash, now());
    if (!grant) return notFound();

    try {
      const response = await streamMediaObject(
        makeBucket(c.env),
        grant.objectKey,
        c.req.raw,
        `${grant.id}-provider-media`,
      );
      privateNoStore(response);
      if (response.status === 200 || response.status === 206) {
        await grants.markAccessed(grant.id, now());
      }
      return response;
    } catch (error) {
      if (error instanceof MediaObjectNotFoundError) return notFound();
      throw error;
    }
  });

  return routes;
}
