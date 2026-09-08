import { Hono } from 'hono';
import { ProjectInputError, normalizeProjectInput } from '../domain/project';
import {
  LOCAL_INFERENCE_MAX_COMMIT_BYTES,
  LocalInferenceInputError,
  normalizeClientInferenceInput,
} from '../domain/client-inference';
import { ClientInferenceCommitError, ClientInferenceRepository } from '../db/client-inference';
import { ProjectRepository, type ProjectStore } from '../db/projects';
import { getCurrentUserId } from '../security/current-user';
import { errorBody } from '../http/json';
import type { Env } from '../env';

export type ProjectStoreFactory = (env: Env) => ProjectStore;

async function readBoundedJson(request: Request): Promise<unknown> {
  const announced = request.headers.get('content-length');
  if (announced !== null) {
    const bytes = Number(announced);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > LOCAL_INFERENCE_MAX_COMMIT_BYTES) {
      throw new LocalInferenceInputError('Browser-local inference payload exceeds the 2 MiB boundary.');
    }
  }

  const body = request.body;
  if (!body) throw new LocalInferenceInputError();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > LOCAL_INFERENCE_MAX_COMMIT_BYTES) {
        await reader.cancel();
        throw new LocalInferenceInputError('Browser-local inference payload exceeds the 2 MiB boundary.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LocalInferenceInputError();
  }
}

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

  routes.put('/:id/client-inference/vi', async (c) => {
    const projectId = c.req.param('id');
    try {
      const payload = await readBoundedJson(c.req.raw);
      const input = normalizeClientInferenceInput(projectId, payload);
      const result = await new ClientInferenceRepository(c.env.DB).commit(projectId, getCurrentUserId(), input);
      return c.json(result);
    } catch (error) {
      if (error instanceof LocalInferenceInputError) {
        return c.json(errorBody(error.code, error.message), 400);
      }
      if (error instanceof ClientInferenceCommitError) {
        if (error.code === 'PROJECT_NOT_FOUND') {
          return c.json(errorBody(error.code, 'Project not found.'), 404);
        }
        if (error.code === 'LOCAL_INFERENCE_SOURCE_CONFLICT') {
          return c.json({ ...errorBody(error.code, error.message), source: error.source }, 409);
        }
        if (error.code === 'LOCAL_INFERENCE_UNAVAILABLE') {
          return c.json(errorBody(error.code, error.message), 409);
        }
        return c.json(errorBody('LOCAL_INFERENCE_COMMIT_FAILED', 'Unable to commit browser-local inference.'), 500);
      }
      return c.json(errorBody('LOCAL_INFERENCE_COMMIT_FAILED', 'Unable to commit browser-local inference.'), 500);
    }
  });

  routes.get('/', async (c) => {
    const projects = await makeStore(c.env).listByUser(getCurrentUserId());
    return c.json(projects);
  });

  routes.get('/:id', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    const project = await makeStore(c.env).getByIdForUser(projectId, userId);
    if (!project) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    try {
      const clientInferenceState = await new ClientInferenceRepository(c.env.DB).getState(projectId, userId);
      return c.json({ ...project, clientInferenceState });
    } catch {
      return c.json({ ...project, clientInferenceState: null });
    }
  });

  return routes;
}
