import { describe, expect, it } from 'vitest';
import type { Project, ProjectStatus, ProjectStore } from '../src/db/projects';
import { ProcessService } from '../src/services/jobs';

class Store implements ProjectStore {
  constructor(public project: Project) {}
  async create(): Promise<Project> { return this.project; }
  async listByUser(): Promise<Project[]> { return [this.project]; }
  async getByIdForUser(id: string, userId: string) { return id === this.project.id && userId === this.project.userId ? this.project : null; }
  async setSourceObject() {}
  async setExportObject(_id: string, _userId: string, objectKey: string) { this.project.exportObjectKey = objectKey; }
  async setStatus(_id: string, _userId: string, status: ProjectStatus, durationMs?: number) {
    this.project.status = status;
    if (durationMs !== undefined) this.project.durationMs = durationMs;
  }
}

describe('media processing boundary', () => {
  it('requires an uploaded source object', async () => {
    const service = new ProcessService(new Store({ id: 'p', userId: 'u', title: 'x', sourceLanguage: 'zh', targetLanguage: 'vi', targetLanguagesRevision: 1, sourceGeneration: 1, status: 'draft' }));
    await expect(service.start('p', 'u')).rejects.toMatchObject({ code: 'SOURCE_MEDIA_REQUIRED' });
  });

  it('returns explicit unavailable status instead of fake export completion', async () => {
    const service = new ProcessService(new Store({ id: 'p', userId: 'u', title: 'x', sourceLanguage: 'zh', targetLanguage: 'vi', targetLanguagesRevision: 1, sourceGeneration: 1, status: 'ready', sourceObjectKey: 'projects/p/source/x.mp4' }));
    expect(await service.start('p', 'u')).toEqual({
      status: 'blocked',
      code: 'MEDIA_PROCESSOR_UNAVAILABLE',
      message: 'FFmpeg media processor is not configured yet.',
    });
  });
});
