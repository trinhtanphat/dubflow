import { describe, expect, it, vi } from 'vitest';
import { ProjectRepository } from '../src/db/projects';
import { SegmentRepository } from '../src/db/segments';

type Call = { sql: string; values: unknown[] };

function captureDb() {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async run() { calls.push({ sql, values }); return {}; },
        async all<T>() { return { results: [] as T[] }; },
        async first<T>() { return null as T | null; },
      };
    },
  };
  return { db: db as any, calls };
}

describe('export persistence', () => {
  it('persists a project-scoped final export object key', async () => {
    const { db, calls } = captureDb();
    const repo = new ProjectRepository(db);
    await repo.setExportObject('p1', 'dev-user', 'projects/p1/export/dubbed.mp4');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/export_object_key/);
    expect(calls[0].values).toEqual(['projects/p1/export/dubbed.mp4', 'p1', 'dev-user']);
  });

  it('rejects a final export object outside the project prefix', async () => {
    const { db } = captureDb();
    const repo = new ProjectRepository(db);
    await expect(repo.setExportObject('p1', 'dev-user', 'projects/p2/export/dubbed.mp4'))
      .rejects.toThrow(/project/i);
  });

  it('persists a generated segment voice object and completed status', async () => {
    const { db, calls } = captureDb();
    const repo = new SegmentRepository(db);
    await repo.setVoiceResult('p1', 's1', 'dev-user', 'projects/p1/dubbed/s1.mp3');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/dubbed_object_key/);
    expect(calls[0].sql).toMatch(/voice_status\s*=\s*'completed'/);
    expect(calls[0].values).toEqual(['projects/p1/dubbed/s1.mp3', 's1', 'p1', 'dev-user']);
  });

  it('rejects a voice object outside the project prefix', async () => {
    const { db } = captureDb();
    const repo = new SegmentRepository(db);
    await expect(repo.setVoiceResult('p1', 's1', 'dev-user', 'projects/p2/dubbed/s1.mp3'))
      .rejects.toThrow(/project/i);
  });
});
