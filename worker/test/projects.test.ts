import { describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { ProjectRow } from '../src/domain/project';

type FakeState = { projects: ProjectRow[] };

function fakeDb(state: FakeState): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (sql.startsWith('INSERT INTO projects')) {
                const [id, userId, title, sourceLanguage, targetLanguage, status, createdAt, updatedAt] = params;
                state.projects.push({
                  id: String(id),
                  user_id: String(userId),
                  title: String(title),
                  source_language: sourceLanguage as ProjectRow['source_language'],
                  target_language: targetLanguage as 'vi',
                  status: String(status),
                  source_object_key: null,
                  duration_ms: null,
                  size_bytes: null,
                  created_at: String(createdAt),
                  updated_at: String(updatedAt),
                });
              }
              return { success: true };
            },
            async all<T>() {
              const userId = String(params[0]);
              return { results: state.projects.filter((project) => project.user_id === userId) as T[] };
            },
            async first<T>() {
              const [id, userId] = params.map(String);
              return (state.projects.find((project) => project.id === id && project.user_id === userId) ?? null) as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function env(db: D1Database) {
  return { DB: db } as never;
}

describe('/api/projects', () => {
  it('creates, lists and fetches a project with Vietnamese as the target language', async () => {
    const state: FakeState = { projects: [] };
    const DB = fakeDb(state);

    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '仙侠奇缘 第01集', sourceLanguage: 'zh' }),
    }, env(DB));

    expect(created.status).toBe(201);
    const createdBody = await created.json() as { project: ProjectRow };
    expect(createdBody.project.title).toBe('仙侠奇缘 第01集');
    expect(createdBody.project.source_language).toBe('zh');
    expect(createdBody.project.target_language).toBe('vi');
    expect(createdBody.project.user_id).toBe('dev-user');

    const listed = await app.request('/api/projects', {}, env(DB));
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { projects: ProjectRow[] };
    expect(listBody.projects).toHaveLength(1);

    const fetched = await app.request(`/api/projects/${createdBody.project.id}`, {}, env(DB));
    expect(fetched.status).toBe(200);
    const fetchBody = await fetched.json() as { project: ProjectRow };
    expect(fetchBody.project.id).toBe(createdBody.project.id);
  });

  it('rejects unsupported source languages before writing to D1', async () => {
    const state: FakeState = { projects: [] };
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Unsupported source', sourceLanguage: 'fr' }),
    }, env(fakeDb(state)));

    expect(response.status).toBe(400);
    expect(state.projects).toHaveLength(0);
  });
});
