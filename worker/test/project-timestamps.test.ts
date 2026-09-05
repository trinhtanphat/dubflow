import { describe, expect, it } from 'vitest';
import { ProjectRepository } from '../src/db/projects';

function timestampDb() {
  const row = {
    id: 'p1',
    user_id: 'dev-user',
    title: 'Episode 01',
    source_language: 'zh' as const,
    target_language: 'vi' as const,
    status: 'needs_review' as const,
    source_object_key: 'projects/p1/source/video.mp4',
    export_object_key: null,
    duration_ms: 120000,
    size_bytes: 1234,
    created_at: '2026-09-05T12:00:00Z',
    updated_at: '2026-09-05T12:05:00Z',
  };
  return {
    prepare(statement: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async run() { return { meta: { changes: 1 } }; },
        async all<T>() {
          if (statement.includes('FROM projects WHERE user_id = ?')) {
            expect(values).toEqual(['dev-user']);
            return { results: [row as T] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (statement.includes('FROM projects WHERE id = ?')) {
            expect(values).toEqual(['p1', 'dev-user']);
            return row as T;
          }
          return null;
        },
      };
    },
  };
}

describe('durable project timestamps', () => {
  it('maps existing D1 created_at and updated_at through list and get', async () => {
    const repo = new ProjectRepository(timestampDb());
    const list = await repo.listByUser('dev-user');
    const one = await repo.getByIdForUser('p1', 'dev-user');

    expect(list[0]).toMatchObject({
      id: 'p1',
      createdAt: '2026-09-05T12:00:00Z',
      updatedAt: '2026-09-05T12:05:00Z',
    });
    expect(one).toMatchObject({
      createdAt: '2026-09-05T12:00:00Z',
      updatedAt: '2026-09-05T12:05:00Z',
    });
  });
});
