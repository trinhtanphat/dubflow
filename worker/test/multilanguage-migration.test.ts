import { describe, expect, it } from 'vitest';
import { ProjectRepository, type D1DatabaseLike, type D1RunResultLike, type D1StatementLike } from '../src/db/projects';
import { TARGET_LANGUAGES, isTargetLanguage } from '../src/domain/language';

class MemoryStatement implements D1StatementLike {
  bind(..._values: unknown[]): D1StatementLike { return this; }
  async run(): Promise<D1RunResultLike> { return { meta: { changes: 1 } }; }
  async all<T>(): Promise<{ results?: T[] }> { return { results: [] }; }
  async first<T>(): Promise<T | null> { return null; }
}

const db: D1DatabaseLike = {
  prepare: () => new MemoryStatement(),
};

describe('Phase 4C canonical target domain and schema bridge', () => {
  it('defines exactly the five canonical Phase 4C target languages', () => {
    expect(TARGET_LANGUAGES).toEqual(['vi', 'en', 'zh', 'ja', 'ko']);
    expect(isTargetLanguage('ja')).toBe(true);
    expect(isTargetLanguage('fr')).toBe(false);
  });

  it('starts newly created legacy-compatible projects at target language revision one', async () => {
    const project = await new ProjectRepository(db).create('dev-user', {
      title: 'Episode',
      sourceLanguage: 'zh',
      targetLanguage: 'vi',
    });
    expect(project.targetLanguage).toBe('vi');
    expect(project.targetLanguagesRevision).toBe(1);
  });
});
