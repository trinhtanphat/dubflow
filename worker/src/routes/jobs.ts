import { Hono } from 'hono';
import type { Env } from '../env';
import { JobRepository, type JobStore } from '../db/jobs';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';

export type JobStoreFactory = (env: Env) => JobStore;

export function createJobRoutes(
  makeStore: JobStoreFactory = (env) => new JobRepository(env.DB),
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/:id/jobs/:jobId', async (c) => {
    const job = await makeStore(c.env).getForProject(
      c.req.param('id'),
      c.req.param('jobId'),
      getCurrentUserId(),
    );
    return job
      ? c.json(job)
      : c.json(errorBody('JOB_NOT_FOUND', 'Job not found.'), 404);
  });

  return routes;
}
