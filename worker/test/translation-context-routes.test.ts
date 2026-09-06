import { describe, expect, it } from 'vitest';
import type { TranslationContextStore } from '../src/db/translation-context';
import { TranslationContextPersistenceError } from '../src/db/translation-context';
import type { Env } from '../src/env';
import {
  normalizeGlossaryInput,
  validateTranslationStyle,
  type GlossaryEntry,
  type GlossaryEntryInput,
  type TranslationContext,
  type TranslationStyle,
} from '../src/services/translation/context';

const initialEntry: GlossaryEntry = {
  id: 'entry-1',
  projectId: 'project-1',
  targetLanguage: 'vi',
  sourceTerm: 'DubFlow',
  preferredTranslation: 'DubFlow',
  note: null,
  caseSensitive: true,
  createdAt: '2026-09-06T00:00:00Z',
  updatedAt: '2026-09-06T00:00:00Z',
};

function cloneContext(context: TranslationContext): TranslationContext {
  return {
    revision: context.revision,
    style: context.style,
    glossary: context.glossary.map((entry) => ({ ...entry })),
  };
}

class ContextStoreFake implements TranslationContextStore {
  context: TranslationContext = {
    revision: 4,
    style: 'neutral',
    glossary: [initialEntry],
  };
  seenUsers: string[] = [];

  private owned(projectId: string, userId: string): boolean {
    this.seenUsers.push(userId);
    return projectId === 'project-1' && userId === 'dev-user';
  }

  private requireRevision(expectedRevision: number): void {
    if (expectedRevision !== this.context.revision) {
      throw new TranslationContextPersistenceError(
        'TRANSLATION_CONTEXT_CONFLICT',
        'Translation settings changed elsewhere.',
        cloneContext(this.context),
      );
    }
  }

  async getContext(projectId: string, userId: string): Promise<TranslationContext | null> {
    return this.owned(projectId, userId) ? cloneContext(this.context) : null;
  }

  async updateStyle(
    projectId: string,
    userId: string,
    expectedRevision: number,
    style: TranslationStyle,
  ): Promise<TranslationContext> {
    if (!this.owned(projectId, userId)) {
      throw new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    }
    this.requireRevision(expectedRevision);
    const normalized = validateTranslationStyle(style);
    if (normalized !== this.context.style) {
      this.context = { ...this.context, style: normalized, revision: this.context.revision + 1 };
    }
    return cloneContext(this.context);
  }

  async createEntry(
    projectId: string,
    userId: string,
    expectedRevision: number,
    input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    if (!this.owned(projectId, userId)) {
      throw new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    }
    this.requireRevision(expectedRevision);
    const normalized = normalizeGlossaryInput(input);
    if (normalized.sourceTerm === 'duplicate') {
      throw new TranslationContextPersistenceError(
        'GLOSSARY_ENTRY_CONFLICT',
        'Duplicate glossary entry.',
        cloneContext(this.context),
      );
    }
    if (normalized.sourceTerm === 'limit') {
      throw new TranslationContextPersistenceError(
        'GLOSSARY_LIMIT_REACHED',
        'Glossary limit reached.',
        cloneContext(this.context),
      );
    }
    const entry: GlossaryEntry = {
      id: 'entry-new',
      projectId,
      targetLanguage: normalized.targetLanguage,
      sourceTerm: normalized.sourceTerm,
      preferredTranslation: normalized.preferredTranslation,
      note: normalized.note,
      caseSensitive: normalized.caseSensitive,
      createdAt: '2026-09-06T00:01:00Z',
      updatedAt: '2026-09-06T00:01:00Z',
    };
    this.context = {
      ...this.context,
      revision: this.context.revision + 1,
      glossary: [...this.context.glossary, entry],
    };
    return { entry: { ...entry }, context: cloneContext(this.context) };
  }

  async updateEntry(
    projectId: string,
    entryId: string,
    userId: string,
    expectedRevision: number,
    input: GlossaryEntryInput,
  ): Promise<{ entry: GlossaryEntry; context: TranslationContext }> {
    if (!this.owned(projectId, userId)) {
      throw new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    }
    this.requireRevision(expectedRevision);
    const normalized = normalizeGlossaryInput(input);
    const index = this.context.glossary.findIndex((entry) => entry.id === entryId);
    if (index < 0) {
      throw new TranslationContextPersistenceError(
        'GLOSSARY_ENTRY_NOT_FOUND',
        'Glossary entry not found.',
        cloneContext(this.context),
      );
    }
    const entry: GlossaryEntry = {
      ...this.context.glossary[index],
      targetLanguage: normalized.targetLanguage,
      sourceTerm: normalized.sourceTerm,
      preferredTranslation: normalized.preferredTranslation,
      note: normalized.note,
      caseSensitive: normalized.caseSensitive,
      updatedAt: '2026-09-06T00:02:00Z',
    };
    this.context = {
      ...this.context,
      revision: this.context.revision + 1,
      glossary: this.context.glossary.map((candidate, candidateIndex) => candidateIndex === index ? entry : candidate),
    };
    return { entry: { ...entry }, context: cloneContext(this.context) };
  }

  async deleteEntry(
    projectId: string,
    entryId: string,
    userId: string,
    expectedRevision: number,
  ): Promise<TranslationContext> {
    if (!this.owned(projectId, userId)) {
      throw new TranslationContextPersistenceError('PROJECT_NOT_FOUND', 'Project not found.');
    }
    this.requireRevision(expectedRevision);
    if (!this.context.glossary.some((entry) => entry.id === entryId)) {
      throw new TranslationContextPersistenceError(
        'GLOSSARY_ENTRY_NOT_FOUND',
        'Glossary entry not found.',
        cloneContext(this.context),
      );
    }
    this.context = {
      ...this.context,
      revision: this.context.revision + 1,
      glossary: this.context.glossary.filter((entry) => entry.id !== entryId),
    };
    return cloneContext(this.context);
  }
}

function env(model = '@cf/example/context-model'): Env {
  return { CONTEXT_TRANSLATION_MODEL: model } as unknown as Env;
}

async function routesFor(store: TranslationContextStore) {
  const { createTranslationContextRoutes } = await import('../src/routes/translation-context');
  return createTranslationContextRoutes({ makeContext: () => store });
}

async function jsonRequest(
  routes: Awaited<ReturnType<typeof routesFor>>,
  path: string,
  method: string,
  body?: unknown,
  runtimeEnv: Env = env(),
) {
  return routes.fetch(new Request(`https://yupvox.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), runtimeEnv);
}

describe('translation context HTTP routes', () => {
  it('returns owner settings and derives contextual availability from trimmed configuration', async () => {
    const store = new ContextStoreFake();
    const routes = await routesFor(store);

    const configured = await jsonRequest(routes, '/project-1/translation-settings', 'GET');
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toEqual({
      stylePreset: 'neutral',
      contextRevision: 4,
      contextualAvailable: true,
    });

    const blank = await jsonRequest(routes, '/project-1/translation-settings', 'GET', undefined, env('   '));
    await expect(blank.json()).resolves.toMatchObject({ contextualAvailable: false });
    expect(store.seenUsers.every((userId) => userId === 'dev-user')).toBe(true);
  });

  it('patches style with the expected context revision', async () => {
    const store = new ContextStoreFake();
    const routes = await routesFor(store);
    const response = await jsonRequest(routes, '/project-1/translation-settings', 'PATCH', {
      stylePreset: 'natural',
      expectedContextRevision: 4,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      stylePreset: 'natural',
      contextRevision: 5,
      contextualAvailable: true,
    });
  });

  it('lists the owner glossary with its canonical context revision', async () => {
    const store = new ContextStoreFake();
    const routes = await routesFor(store);
    const response = await jsonRequest(routes, '/project-1/glossary', 'GET');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contextRevision: 4,
      glossary: [{ id: 'entry-1', sourceTerm: 'DubFlow' }],
    });
  });

  it('creates, updates, and deletes glossary entries while returning canonical context', async () => {
    const store = new ContextStoreFake();
    const routes = await routesFor(store);

    const created = await jsonRequest(routes, '/project-1/glossary', 'POST', {
      expectedContextRevision: 4,
      sourceTerm: 'GPU',
      preferredTranslation: 'GPU',
      note: 'Keep acronym',
      caseSensitive: true,
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      entry: { id: 'entry-new', sourceTerm: 'GPU' },
      contextRevision: 5,
      context: { revision: 5, glossary: expect.any(Array) },
    });

    const updated = await jsonRequest(routes, '/project-1/glossary/entry-new', 'PATCH', {
      expectedContextRevision: 5,
      sourceTerm: 'GPU',
      preferredTranslation: 'bộ xử lý đồ họa',
      note: null,
      caseSensitive: true,
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      entry: { id: 'entry-new', preferredTranslation: 'bộ xử lý đồ họa' },
      contextRevision: 6,
      context: { revision: 6 },
    });

    const deleted = await jsonRequest(routes, '/project-1/glossary/entry-new', 'DELETE', {
      expectedContextRevision: 6,
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      contextRevision: 7,
      context: { revision: 7, glossary: [{ id: 'entry-1' }] },
    });
  });

  it('hides inaccessible projects behind 404 and never accepts client user identity', async () => {
    const store = new ContextStoreFake();
    const routes = await routesFor(store);
    const response = await jsonRequest(routes, '/other-project/translation-settings?userId=attacker', 'GET');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(store.seenUsers).toEqual(['dev-user']);
  });

  it('maps validation failures to 400', async () => {
    const store = new ContextStoreFake();
    const routes = await routesFor(store);
    const response = await jsonRequest(routes, '/project-1/glossary', 'POST', {
      expectedContextRevision: 4,
      sourceTerm: '   ',
      preferredTranslation: 'x',
      caseSensitive: false,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'GLOSSARY_SOURCE_TERM_INVALID' });
  });

  it('maps canonical duplicate and project limit failures to 409', async () => {
    const duplicateStore = new ContextStoreFake();
    const duplicateRoutes = await routesFor(duplicateStore);
    const duplicate = await jsonRequest(duplicateRoutes, '/project-1/glossary', 'POST', {
      expectedContextRevision: 4,
      sourceTerm: 'duplicate',
      preferredTranslation: 'x',
      caseSensitive: false,
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ code: 'GLOSSARY_ENTRY_CONFLICT' });

    const limitStore = new ContextStoreFake();
    const limitRoutes = await routesFor(limitStore);
    const limit = await jsonRequest(limitRoutes, '/project-1/glossary', 'POST', {
      expectedContextRevision: 4,
      sourceTerm: 'limit',
      preferredTranslation: 'x',
      caseSensitive: false,
    });
    expect(limit.status).toBe(409);
    await expect(limit.json()).resolves.toMatchObject({ code: 'GLOSSARY_LIMIT_REACHED' });
  });

  it('returns stale revision conflicts with the canonical recovery snapshot', async () => {
    const store = new ContextStoreFake();
    store.context = { revision: 5, style: 'natural', glossary: [initialEntry] };
    const routes = await routesFor(store);
    const response = await jsonRequest(routes, '/project-1/translation-settings', 'PATCH', {
      stylePreset: 'formal',
      expectedContextRevision: 4,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'TRANSLATION_CONTEXT_CONFLICT',
      context: {
        revision: 5,
        style: 'natural',
        glossary: expect.any(Array),
      },
    });
  });

  it('maps a missing glossary entry to 404', async () => {
    const store = new ContextStoreFake();
    const routes = await routesFor(store);
    const response = await jsonRequest(routes, '/project-1/glossary/missing', 'DELETE', {
      expectedContextRevision: 4,
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'GLOSSARY_ENTRY_NOT_FOUND' });
  });
});
