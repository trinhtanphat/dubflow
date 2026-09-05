import { Hono } from 'hono';
import { UsageRepository, type UsageStore } from '../db/usage';
import type { Env } from '../env';
import { errorBody } from '../http/json';
import { getCurrentUserId } from '../security/current-user';

export type UsageStoreFactory = (env: Env) => UsageStore;

export function createUsageRoutes(
  makeStore: UsageStoreFactory = (env) => new UsageRepository(env.DB),
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/summary', async (c) => {
    try {
      const summary = await makeStore(c.env).summaryForUser(getCurrentUserId());
      return c.json(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read usage summary.';
      return c.json(errorBody('USAGE_SUMMARY_FAILED', message), 500);
    }
  });

  return routes;
}
