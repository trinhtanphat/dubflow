import { describe, expect, it } from 'vitest';
import { ProjectRepository, type D1DatabaseLike, type D1StatementLike } from '../src/db/projects';

function streamProjectDb() {
  const columns = [
    'id', 'user_id', 'title', 'source_language', 'target_language', 'target_languages_revision', 'status',
    'source_object_key', 'export_object_key', 'duration_ms', 'size_bytes', 'created_at', 'updated_at',
    'stream_video_uid', 'stream_source_object_key', 'stream_ready_at',
  ];
  const runs: Array<{ sql: string; values: unknown[] }> = [];
  const row = {
    id: 'p1', user_id: 'dev-user', title: 'Episode', source_language: 'zh', target_language: 'vi',
    target_languages_revision: 1, status: 'ready', source_object_key: 'projects/p1/source/a.mp4',
    export_object_key: null, duration_ms: null, size_bytes: 100, created_at: 'now', updated_at: 'now',
    stream_video_uid: 'stream-1', stream_source_object_key: 'projects/p1/source/a.mp4', stream_ready_at: '2026-09-06T16:00:00Z',
  };
  const db: D1DatabaseLike = {
    prepare(sql: string): D1StatementLike {
      let values: unknown[] = [];
      const statement: D1StatementLike = {
        bind(...next: unknown[]) { values = next; return statement; },
        async run() { runs.push({ sql, values }); return { meta: { changes: 1 } }; },
        async all<T>() {
          if (/PRAGMA\s+table_info/i.test(sql)) return { results: columns.map((name) => ({ name })) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/FROM\s+projects/i.test(sql)) return row as T;
          return null;
        },
      };
      return statement;
    },
  };
  return { db, runs };
}

describe('project Stream provenance', () => {
  it('reads Stream provenance from schema 11 project rows', async () => {
    const { db } = streamProjectDb();
    const project = await new ProjectRepository(db).getByIdForUser('p1', 'dev-user');
    expect(project).toMatchObject({
      streamVideoUid: 'stream-1',
      streamSourceObjectKey: 'projects/p1/source/a.mp4',
      streamReadyAt: '2026-09-06T16:00:00Z',
    });
  });

  it('persists and clears Stream provenance only for the owned project', async () => {
    const { db, runs } = streamProjectDb();
    const repo = new ProjectRepository(db) as ProjectRepository & {
      setStreamProvenance(id: string, userId: string, sourceObjectKey: string, videoUid: string, readyAt?: string | null): Promise<void>;
      clearStreamProvenance(id: string, userId: string): Promise<void>;
    };
    await repo.setStreamProvenance('p1', 'dev-user', 'projects/p1/source/a.mp4', 'stream-2', '2026-09-06T16:10:00Z');
    await repo.clearStreamProvenance('p1', 'dev-user');

    expect(runs[0]?.sql).toContain('stream_video_uid = ?');
    expect(runs[0]?.values).toEqual(['stream-2', 'projects/p1/source/a.mp4', '2026-09-06T16:10:00Z', 'p1', 'dev-user']);
    expect(runs[1]?.sql).toContain('stream_video_uid = NULL');
    expect(runs[1]?.values).toEqual(['p1', 'dev-user']);
  });
});
