import { Hono } from 'hono';
import type { Env } from '../env';
import { UsageAccessError, UsageRepository, type UsageStore } from '../db/usage';
import { errorBody } from '../http/json';
import { getCurrentUserId } from '../security/current-user';

export type UsageStoreFactory = (env: Env) => UsageStore;

export function createUsageRoutes(
  makeStore: UsageStoreFactory = (env) => new UsageRepository(env.DB),
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/usage', async (c) => {
    try {
      const userId = getCurrentUserId();
      const store = makeStore(c.env);
      const [summary, creditBalance] = await Promise.all([
        store.summarizeForUser(userId),
        store.getCreditBalance(userId),
      ]);
      return c.json({ creditBalance, ...summary });
    } catch {
      return c.json(errorBody('USAGE_SUMMARY_FAILED', 'Unable to load usage summary.'), 500);
    }
  });

  routes.get('/projects/:id/usage', async (c) => {
    try {
      const summary = await makeStore(c.env).summarizeForProject(
        c.req.param('id'),
        getCurrentUserId(),
      );
      return c.json(summary);
    } catch (error) {
      if (error instanceof UsageAccessError && error.code === 'PROJECT_NOT_FOUND') {
        return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      }
      return c.json(errorBody('USAGE_SUMMARY_FAILED', 'Unable to load usage summary.'), 500);
    }
  });

  return routes;
}
