import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { MultilangRepository, type MultilangStore } from '../db/multilang';
import { parseProjectTargetLanguages } from '../domain/target-language';
import { errorBody } from '../http/json';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';

export type ProjectTargetRouteDeps = {
  makeProjects?: (env: Env) => ProjectStore;
  makeMultilang?: (env: Env) => MultilangStore;
};

export function createProjectTargetRoutes(deps: ProjectTargetRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeProjects = deps.makeProjects ?? ((env: Env) => new ProjectRepository(env.DB));
  const makeMultilang = deps.makeMultilang ?? ((env: Env) => new MultilangRepository(env.DB));

  routes.get('/:id/targets', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    return c.json({ targets: await makeMultilang(c.env).listTargets(projectId, userId) });
  });

  routes.put('/:id/targets', async (c) => {
    const userId = getCurrentUserId();
    const projectId = c.req.param('id');
    const project = await makeProjects(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    const body = await c.req.json().catch(() => null) as { targetLanguages?: unknown } | null;
    try {
      const requested = parseProjectTargetLanguages(body?.targetLanguages);
      const targets = await makeMultilang(c.env).replaceTargets(projectId, userId, requested);
      return c.json({ targets });
    } catch (error) {
      return c.json(errorBody('TARGET_LANGUAGES_INVALID', error instanceof Error ? error.message : 'Invalid target languages.'), 400);
    }
  });

  return routes;
}
