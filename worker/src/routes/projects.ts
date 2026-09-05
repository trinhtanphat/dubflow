import { Hono } from 'hono';
import { ProjectInputError, normalizeProjectInput } from '../domain/project';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';
import type { Env } from '../env';

export type ProjectStoreFactory = (env: Env) => ProjectStore;

export function createProjectsRoutes(
  makeStore: ProjectStoreFactory = (env) => new ProjectRepository(env.DB),
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/', async (c) => {
    try {
      const input = normalizeProjectInput(await c.req.json());
      const project = await makeStore(c.env).create(getCurrentUserId(), input);
      return c.json(project, 201);
    } catch (error) {
      if (error instanceof ProjectInputError) {
        return c.json(errorBody(error.code, error.message), 400);
      }
      return c.json(errorBody('PROJECT_CREATE_FAILED', 'Unable to create project.'), 500);
    }
  });

  routes.get('/', async (c) => {
    const projects = await makeStore(c.env).listByUser(getCurrentUserId());
    return c.json(projects);
  });

  routes.get('/:id', async (c) => {
    const project = await makeStore(c.env).getByIdForUser(c.req.param('id'), getCurrentUserId());
    return project
      ? c.json(project)
      : c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
  });

  return routes;
}
