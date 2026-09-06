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

function languageError(error: ProjectLanguagePersistenceError) {
  if (error.code === 'PROJECT_NOT_FOUND') {
    return { status: 404 as const, body: errorBody(error.code, error.message) };
  }
  if (error.code === 'PROJECT_LANGUAGES_CONFLICT') {
    return {
      status: 409 as const,
      body: { ...errorBody(error.code, error.message), canonical: error.canonical },
    };
  }
  return { status: 400 as const, body: errorBody(error.code, error.message) };
}

function validateTargets(value: unknown):
  | { ok: true; targets: TargetLanguage[] }
  | { ok: false; code: 'PROJECT_LANGUAGES_INVALID' | 'TARGET_LANGUAGE_UNSUPPORTED'; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, code: 'PROJECT_LANGUAGES_INVALID', message: 'At least one target language is required.' };
  }
  if (value.some((target) => !isTargetLanguage(target))) {
    return { ok: false, code: 'TARGET_LANGUAGE_UNSUPPORTED', message: 'One or more target languages are unsupported.' };
  }
  const targets = value as TargetLanguage[];
  if (new Set(targets).size !== targets.length) {
    return { ok: false, code: 'PROJECT_LANGUAGES_INVALID', message: 'Target languages must be unique.' };
  }
  return { ok: true, targets };
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
    const languages = makeLanguages(c.env);

    const current = await languages.getConfig(projectId, userId);
    if (!current) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);

    let input: { expectedRevision?: unknown; targetLanguages?: unknown };
    try {
      input = await c.req.json() as { expectedRevision?: unknown; targetLanguages?: unknown };
    } catch {
      return c.json(errorBody('PROJECT_LANGUAGES_INVALID', 'Request body must contain valid JSON.'), 400);
    }

    if (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
      return c.json(errorBody('PROJECT_LANGUAGES_INVALID', 'expectedRevision must be a positive integer.'), 400);
    }
    const checked = validateTargets(input.targetLanguages);
    if (!checked.ok) return c.json(errorBody(checked.code, checked.message), 400);

    try {
      const updated = await languages.updateEnabled(
        projectId,
        userId,
        Number(input.expectedRevision),
        checked.targets,
      );
      return c.json(updated);
    } catch (error) {
      if (error instanceof ProjectLanguagePersistenceError) {
        const mapped = languageError(error);
        return c.json(mapped.body, mapped.status);
      }
      return c.json(errorBody('PROJECT_LANGUAGES_FAILED', 'Unable to update project languages.'), 500);
    }
  });

  return routes;
}
