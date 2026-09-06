import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1StatementLike } from '../src/db/projects';
import { VoiceCloneRepository } from '../src/db/voice-clones';

class MissingProjectStatement implements D1StatementLike {
  bind(..._values: unknown[]): D1StatementLike { return this; }
  async run() { return { changes: 0 }; }
  async all<T>(): Promise<{ results?: T[] }> {
    throw new Error('voice clone list must not query rows after ownership fails');
  }
  async first<T>(): Promise<T | null> { return null; }
}

class MissingProjectDb implements D1DatabaseLike {
  prepare(_sql: string): D1StatementLike { return new MissingProjectStatement(); }
}

describe('voice clone persistence ownership', () => {
  it('rejects list access when the project is not owned instead of returning an empty list', async () => {
    const repository = new VoiceCloneRepository(new MissingProjectDb());
    await expect(repository.list('project-other-user', 'dev-user')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });
});
