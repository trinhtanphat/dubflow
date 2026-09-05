import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env } from '../env';
import { SOURCE_LANGUAGES } from '../domain/project';
import { ProjectRepository } from '../db/projects';
import { getCurrentUserId } from '../security/current-user';
import { apiError } from '../http/json';

const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(160),
  sourceLanguage: z.enum(SOURCE_LANGUAGES),
});

export const projectsRoute = new Hono<{ Bindings: Env }>();

projectsRoute.get('/', async (c) => {
  const repo = new ProjectRepository(c.env.DB);
  return c.json({ projects: await repo.listByUser(getCurrentUserId()) });
});

projectsRoute.post('/', zValidator('json', createProjectSchema), async (c) => {
  const input = c.req.valid('json');
  const repo = new ProjectRepository(c.env.DB);
  const project = await repo.create(getCurrentUserId(), input.title, input.sourceLanguage);
  return c.json({ project }, 201);
});

projectsRoute.get('/:id', async (c) => {
  const repo = new ProjectRepository(c.env.DB);
  const project = await repo.getByIdForUser(c.req.param('id'), getCurrentUserId());
  if (!project) return c.json(apiError('PROJECT_NOT_FOUND', 'Project not found.'), 404);
  return c.json({ project });
});
