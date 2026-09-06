import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  ProjectLanguagePersistenceError,
  type ProjectLanguageConfig,
  type ProjectLanguageStore,
} from '../src/db/project-languages';
import type { ProjectLanguageStatus, TargetLanguage } from '../src/domain/language';

class LanguageStoreFake implements ProjectLanguageStore {
  config: ProjectLanguageConfig | null = {
    revision: 3,
    languages: [
      { targetLanguage: 'ja', status: 'needs_review' },
      { targetLanguage: 'vi', status: 'needs_review' },
    ],
  };
  updates: Array<{ projectId: string; userId: string; expectedRevision: number; targets: TargetLanguage[] }> = [];
  seenUsers: string[] = [];
  conflict = false;

  async getConfig(projectId: string, userId: string): Promise<ProjectLanguageConfig | null> {
    this.seenUsers.push(userId);
    return projectId === 'project-1' ? this.config : null;
  }

  async updateEnabled(
    projectId: string,
    userId: string,
    expectedRevision: number,
    targets: TargetLanguage[],
  ): Promise<ProjectLanguageConfig> {
    this.updates.push({ projectId, userId, expectedRevision, targets });
    if (this.conflict) {
      throw new ProjectLanguagePersistenceError(
        'PROJECT_LANGUAGES_CONFLICT',
        'Project language configuration changed on the server.',
        this.config ?? undefined,
      );
    }
    this.config = {
      revision: expectedRevision + 1,
      languages: [...targets].sort().map((targetLanguage) => ({ targetLanguage, status: 'pending' as ProjectLanguageStatus })),
    };
    return this.config;
  }

  async setStatus(): Promise<void> {}
}

async function routesFor(store: ProjectLanguageStore) {
  const { createLanguageRoutes } = await import('../src/routes/languages');
  return createLanguageRoutes({ makeLanguages: () => store });
}

async function request(
  routes: Awaited<ReturnType<typeof routesFor>>,
  path: string,
  method = 'GET',
  body?: unknown,
) {
  return routes.fetch(new Request(`https://yupvox.test${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), {} as Env);
}

describe('Phase 4C language configuration routes', () => {
  it('returns only the owner-scoped canonical language configuration', async () => {
    const store = new LanguageStoreFake();
    const routes = await routesFor(store);
    const response = await request(routes, '/project-1/languages');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(store.config);
    expect(store.seenUsers).toEqual(['dev-user']);

    const hidden = await request(routes, '/other-project/languages');
    expect(hidden.status).toBe(404);
    await expect(hidden.json()).resolves.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('patches an exact unique supported target set using revision CAS', async () => {
    const store = new LanguageStoreFake();
    const routes = await routesFor(store);
    const response = await request(routes, '/project-1/languages', 'PATCH', {
      expectedRevision: 3,
      targetLanguages: ['vi', 'ja', 'ko'],
    });

    expect(response.status).toBe(200);
    expect(store.updates).toEqual([{
      projectId: 'project-1',
      userId: 'dev-user',
      expectedRevision: 3,
      targets: ['vi', 'ja', 'ko'],
    }]);
    await expect(response.json()).resolves.toMatchObject({ revision: 4 });
  });

  it('rejects empty, duplicate, and unsupported target sets before mutation', async () => {
    for (const [targetLanguages, code] of [
      [[], 'PROJECT_LANGUAGES_INVALID'],
      [['ja', 'ja'], 'PROJECT_LANGUAGES_INVALID'],
      [['ja', 'fr'], 'TARGET_LANGUAGE_UNSUPPORTED'],
    ] as const) {
      const store = new LanguageStoreFake();
      const routes = await routesFor(store);
      const response = await request(routes, '/project-1/languages', 'PATCH', {
        expectedRevision: 3,
        targetLanguages,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code });
      expect(store.updates).toHaveLength(0);
    }
  });

  it('returns stale canonical language state on revision conflict', async () => {
    const store = new LanguageStoreFake();
    store.conflict = true;
    const routes = await routesFor(store);
    const response = await request(routes, '/project-1/languages', 'PATCH', {
      expectedRevision: 2,
      targetLanguages: ['vi', 'ja'],
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PROJECT_LANGUAGES_CONFLICT',
      canonical: { revision: 3 },
    });
  });
});
