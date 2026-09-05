import { Hono } from 'hono';
import type { Env } from '../env';
import { ProjectRepository } from '../db/projects';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';
import { ProcessService, ProcessServiceError } from '../services/jobs';

export function createProcessRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.post('/:id/process', async (c) => {
    try {
      const service = new ProcessService(new ProjectRepository(c.env.DB));
      const result = await service.start(c.req.param('id'), getCurrentUserId());
      return c.json(result, result.status === 'blocked' ? 503 : 202);
    } catch (error) {
      if (error instanceof ProcessServiceError) {
        return c.json(errorBody(error.code, error.message), error.code === 'PROJECT_NOT_FOUND' ? 404 : 400);
      }
      return c.json(errorBody('PROCESS_FAILED', 'Unable to start processing.'), 500);
    }
  });
  return routes;
}
