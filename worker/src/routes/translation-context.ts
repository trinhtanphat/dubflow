import { Hono } from 'hono';
import {
  TranslationContextPersistenceError,
  TranslationContextRepository,
  type TranslationContextStore,
} from '../db/translation-context';
import type { TargetLanguage } from '../domain/language';
import type { Env } from '../env';
import { errorBody } from '../http/json';
import { getCurrentUserId } from '../security/current-user';
import {
  TranslationContextValidationError,
  normalizeGlossaryInput,
  validateTargetLanguage,
  validateTranslationStyle,
  type GlossaryEntryInput,
  type TranslationContext,
  type TranslationStyle,
} from '../services/translation/context';

export type TranslationContextRouteDeps = {
  makeContext?: (env: Env) => TranslationContextStore;
};

class TranslationContextRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TranslationContextRequestError';
  }
}

function settingsBody(context: TranslationContext, env: Env) {
  return {
    stylePreset: context.style,
    contextRevision: context.revision,
    contextualAvailable: Boolean(env.CONTEXT_TRANSLATION_MODEL?.trim()),
  };
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TranslationContextRequestError(
      'TRANSLATION_CONTEXT_REQUEST_INVALID',
      'Request body must be a JSON object.',
    );
  }
  return input as Record<string, unknown>;
}

function readExpectedRevision(record: Record<string, unknown>): number {
  const value = record.expectedContextRevision;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new TranslationContextRequestError(
      'TRANSLATION_CONTEXT_REVISION_INVALID',
      'expectedContextRevision must be a positive integer.',
    );
  }
  return value as number;
}

function readTarget(value: unknown): TargetLanguage {
  return validateTargetLanguage(value ?? 'vi');
}

function queryTarget(c: any): TargetLanguage {
  return readTarget(c.req.query('targetLanguage'));
}

async function readJsonRecord(c: any): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    throw new TranslationContextRequestError(
      'TRANSLATION_CONTEXT_REQUEST_INVALID',
      'Request body must contain valid JSON.',
    );
  }
  return requireRecord(payload);
}

function readStyleMutation(record: Record<string, unknown>): {
  expectedRevision: number;
  style: TranslationStyle;
} {
  return {
    expectedRevision: readExpectedRevision(record),
    style: validateTranslationStyle(record.stylePreset),
  };
}

function readGlossaryMutation(record: Record<string, unknown>): {
  expectedRevision: number;
  input: GlossaryEntryInput;
} {
  const expectedRevision = readExpectedRevision(record);
  const normalized = normalizeGlossaryInput({
    targetLanguage: readTarget(record.targetLanguage),
    sourceTerm: record.sourceTerm as string,
    preferredTranslation: record.preferredTranslation as string,
    note: record.note as string | null | undefined,
    caseSensitive: record.caseSensitive as boolean,
  });
  return {
    expectedRevision,
    input: {
      targetLanguage: normalized.targetLanguage,
      sourceTerm: normalized.sourceTerm,
      preferredTranslation: normalized.preferredTranslation,
      note: normalized.note,
      caseSensitive: normalized.caseSensitive,
    },
  };
}

function contextErrorBody(error: TranslationContextPersistenceError) {
  return error.context
    ? { ...errorBody(error.code, error.message), context: error.context }
    : errorBody(error.code, error.message);
}

function translationContextErrorResponse(c: any, error: unknown) {
  if (error instanceof TranslationContextRequestError) {
    return c.json(errorBody(error.code, error.message), 400);
  }
  if (error instanceof TranslationContextValidationError) {
    return c.json(errorBody(error.code, error.message), 400);
  }
  if (error instanceof TranslationContextPersistenceError) {
    if (error.code === 'PROJECT_NOT_FOUND' || error.code === 'GLOSSARY_ENTRY_NOT_FOUND') {
      return c.json(contextErrorBody(error), 404);
    }
    if (
      error.code === 'TRANSLATION_CONTEXT_CONFLICT'
      || error.code === 'GLOSSARY_ENTRY_CONFLICT'
      || error.code === 'GLOSSARY_LIMIT_REACHED'
    ) {
      return c.json(contextErrorBody(error), 409);
    }
    if (error.code === 'TRANSLATION_CONTEXT_TOO_LARGE') {
      return c.json(contextErrorBody(error), 400);
    }
  }
  return c.json(
    errorBody('TRANSLATION_CONTEXT_FAILED', 'Unable to update translation context.'),
    500,
  );
}

export function createTranslationContextRoutes(deps: TranslationContextRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const makeContext = deps.makeContext ?? ((env: Env) => new TranslationContextRepository(env.DB));

  routes.get('/:id/translation-settings', async (c) => {
    try {
      const context = await makeContext(c.env).getContext(c.req.param('id'), getCurrentUserId(), 'vi');
      if (!context) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      return c.json(settingsBody(context, c.env));
    } catch (error) {
      return translationContextErrorResponse(c, error);
    }
  });

  routes.patch('/:id/translation-settings', async (c) => {
    try {
      const request = readStyleMutation(await readJsonRecord(c));
      const context = await makeContext(c.env).updateStyle(
        c.req.param('id'),
        getCurrentUserId(),
        request.expectedRevision,
        request.style,
      );
      return c.json(settingsBody(context, c.env));
    } catch (error) {
      return translationContextErrorResponse(c, error);
    }
  });

  routes.get('/:id/glossary', async (c) => {
    try {
      const targetLanguage = queryTarget(c);
      const context = await makeContext(c.env).getContext(c.req.param('id'), getCurrentUserId(), targetLanguage);
      if (!context) return c.json(errorBody('PROJECT_NOT_FOUND', 'Project not found.'), 404);
      return c.json({
        targetLanguage,
        contextRevision: context.revision,
        glossary: context.glossary,
      });
    } catch (error) {
      return translationContextErrorResponse(c, error);
    }
  });

  routes.post('/:id/glossary', async (c) => {
    try {
      const request = readGlossaryMutation(await readJsonRecord(c));
      const result = await makeContext(c.env).createEntry(
        c.req.param('id'),
        getCurrentUserId(),
        request.expectedRevision,
        request.input,
      );
      return c.json({
        entry: result.entry,
        contextRevision: result.context.revision,
        context: result.context,
      }, 201);
    } catch (error) {
      return translationContextErrorResponse(c, error);
    }
  });

  routes.patch('/:id/glossary/:entryId', async (c) => {
    try {
      const request = readGlossaryMutation(await readJsonRecord(c));
      const result = await makeContext(c.env).updateEntry(
        c.req.param('id'),
        c.req.param('entryId'),
        getCurrentUserId(),
        request.expectedRevision,
        request.input,
      );
      return c.json({
        entry: result.entry,
        contextRevision: result.context.revision,
        context: result.context,
      });
    } catch (error) {
      return translationContextErrorResponse(c, error);
    }
  });

  routes.delete('/:id/glossary/:entryId', async (c) => {
    try {
      const record = await readJsonRecord(c);
      const targetLanguage = readTarget(record.targetLanguage);
      const context = await makeContext(c.env).deleteEntry(
        c.req.param('id'),
        c.req.param('entryId'),
        getCurrentUserId(),
        readExpectedRevision(record),
        targetLanguage,
      );
      return c.json({
        targetLanguage,
        contextRevision: context.revision,
        context,
      });
    } catch (error) {
      return translationContextErrorResponse(c, error);
    }
  });

  return routes;
}
