import { Hono } from 'hono';
import type { Env } from '../env';
import {
  ProjectLanguagePersistenceError,
  ProjectLanguageRepository,
  type ProjectLanguageStore,
} from '../db/project-languages';
import { isTargetLanguage, type TargetLanguage } from '../domain/language';
import { errorBody } from '../http/json';
import type { WorkerHonoEnv } from '../observability/requestTelemetry';
import { getCurrentUserId } from '../security/current-user';

export type LanguageRouteDeps = {
  makeLanguages?: (env: Env) => ProjectLanguageStore;
};

function persistenceResponse(c: any, error: ProjectLanguagePersistenceError) {
  if (error.code === 'PROJECT_NOT_FOUND') {
    return c.json(errorBody(error.code, error.message), 404);
  }
  if (error.code === 'PROJECT_LANGUAGES_CONFLICT') {
    return c.json({ ...errorBody(error.code, error.message), canonical: error.canonical }, 409);
  }
  return c.json(errorBody(error.code, error.message), 400);
}

export function createLanguageRoutes(deps: LanguageRouteDeps = {}) {
  const routes = new Hono<WorkerHonoEnv>();
  const makeLanguages = deps.makeLanguages ?? ((env: Env) => new ProjectLanguageRepository(env.DB));

  routes.get('/:id/languages', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    const config = await makeLanguages(c.env).getConfig(projectId, userId);
    if (!config) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
    return c.json(config);
  });

  routes.patch('/:id/languages', async (c) => {
    const projectId = c.req.param('id');
    const userId = getCurrentUserId();
    let input: {
      expectedRevision?: number;
      expectedLanguagesRevision?: number;
      targetLanguages?: unknown;
    };
    try {
      input = await c.req.json();
    } catch {
      return c.json(errorBody('PROJECT_LANGUAGES_INVALID', 'Request body must contain valid JSON.'), 400);
    }

    const expectedRevision = input.expectedRevision ?? input.expectedLanguagesRevision;
    if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 1) {
      return c.json(errorBody('PROJECT_LANGUAGES_INVALID', 'Expected language revision must be a positive integer.'), 400);
    }
    if (!Array.isArray(input.targetLanguages) || input.targetLanguages.length === 0) {
      return c.json(errorBody('PROJECT_LANGUAGES_INVALID', 'At least one target language is required.'), 400);
    }
    if (input.targetLanguages.some((target) => !isTargetLanguage(target))) {
      return c.json(errorBody('TARGET_LANGUAGE_UNSUPPORTED', 'Target language is unsupported.'), 400);
    }
    const targets = input.targetLanguages as TargetLanguage[];
    if (new Set(targets).size !== targets.length) {
      return c.json(errorBody('PROJECT_LANGUAGES_INVALID', 'Target languages must be unique.'), 400);
    }

    try {
      const config = await makeLanguages(c.env).updateEnabled(
        projectId,
        userId,
        expectedRevision as number,
        targets,
      );
      return c.json(config);
    } catch (error) {
      if (error instanceof ProjectLanguagePersistenceError) return persistenceResponse(c, error);
      return c.json(errorBody('PROJECT_LANGUAGES_FAILED', 'Unable to update project languages.'), 500);
    }
  });

  return routes;
}
