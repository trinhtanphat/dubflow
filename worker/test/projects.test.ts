import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import type { CreateProjectInput } from '../src/domain/project';
import { createProjectsRoutes } from '../src/routes/projects';
import type { Project, ProjectStatus, ProjectStore } from '../src/db/projects';

class MemoryProjectStore implements ProjectStore {
  private projects: Project[] = [];

  async create(userId: string, input: CreateProjectInput): Promise<Project> {
    const project: Project = {
      id: `project-${this.projects.length + 1}`,
      userId,
      title: input.title,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      status: 'draft',
    };
    this.projects.unshift(project);
    return project;
  }

  async listByUser(userId: string): Promise<Project[]> {
    return this.projects.filter((project) => project.userId === userId);
  }

  async getByIdForUser(id: string, userId: string): Promise<Project | null> {
    return this.projects.find((project) => project.id === id && project.userId === userId) ?? null;
  }

  async setSourceObject(id: string, userId: string, objectKey: string, sizeBytes: number): Promise<void> {
    const project = this.projects.find((candidate) => candidate.id === id && candidate.userId === userId);
    if (!project) return;
    project.sourceObjectKey = objectKey;
    project.sizeBytes = sizeBytes;
    project.status = 'ready';
  }

  async setExportObject(id: string, userId: string, objectKey: string): Promise<void> {
    const project = this.projects.find((candidate) => candidate.id === id && candidate.userId === userId);
    if (!project) return;
    project.exportObjectKey = objectKey;
  }

  async setStatus(id: string, userId: string, status: ProjectStatus, durationMs?: number): Promise<void> {
    const project = this.projects.find((candidate) => candidate.id === id && candidate.userId === userId);
    if (!project) return;
    project.status = status;
    if (durationMs !== undefined) project.durationMs = durationMs;
  }
}

function makeApp(store: ProjectStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createProjectsRoutes(() => store));
  return app;
}

describe('project routes', () => {
  it('creates, lists, and reads a Vietnamese-target project', async () => {
    const app = makeApp(new MemoryProjectStore());
    const createdResponse = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Tập 01', sourceLanguage: 'zh', targetLanguage: 'vi' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as Project;
    expect(created.targetLanguage).toBe('vi');

    const listResponse = await app.request('/api/projects');
    expect(await listResponse.json()).toEqual([created]);

    const getResponse = await app.request(`/api/projects/${created.id}`);
    expect(await getResponse.json()).toEqual(created);
  });

  it('rejects unsupported source languages', async () => {
    const app = makeApp(new MemoryProjectStore());
    const response = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Tập 01', sourceLanguage: 'fr', targetLanguage: 'vi' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: true, code: 'INVALID_PROJECT_INPUT' });
  });
});
