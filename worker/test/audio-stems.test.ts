import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1StatementLike } from '../src/db/projects';
import { AudioStemRepository, type AudioStem } from '../src/db/audio-stems';

type Call = { sql: string; values: unknown[]; kind?: 'first' | 'run' | 'all' };

class QueueDb implements D1DatabaseLike {
  readonly calls: Call[] = [];
  constructor(private readonly firstResults: unknown[] = []) {}

  prepare(sql: string): D1StatementLike {
    let values: unknown[] = [];
    const call: Call = { sql, values };
    const statement: D1StatementLike = {
      bind: (...next: unknown[]) => { values = next; call.values = next; return statement; },
      run: async () => { call.kind = 'run'; this.calls.push({ ...call, values: [...values] }); return { meta: { changes: 1 } }; },
      all: async <T>() => { call.kind = 'all'; this.calls.push({ ...call, values: [...values] }); return { results: [] as T[] }; },
      first: async <T>() => { call.kind = 'first'; this.calls.push({ ...call, values: [...values] }); return (this.firstResults.shift() ?? null) as T | null; },
    };
    return statement;
  }
}

const completedRow = {
  id: 'stem-1',
  project_id: 'p1',
  source_generation: 3,
  kind: 'background',
  provider: 'qualified-provider',
  provider_version: 'v1',
  status: 'completed',
  object_key: 'projects/p1/stems/3/qualified-provider/background.wav',
  error_code: null,
  error_message: null,
  created_at: '2026-09-06T00:00:00Z',
  updated_at: '2026-09-06T00:01:00Z',
} as const;

describe('audio stem repository', () => {
  it('selects only an owner-scoped completed stem for the exact source generation and provider', async () => {
    const db = new QueueDb([completedRow]);
    const repo = new AudioStemRepository(db);

    await expect(repo.latestCompleted('p1', 'u1', 3, 'background', 'qualified-provider')).resolves.toMatchObject({
      id: 'stem-1', projectId: 'p1', sourceGeneration: 3, kind: 'background', provider: 'qualified-provider', status: 'completed',
    });

    const lookup = db.calls[0];
    expect(lookup.sql).toMatch(/JOIN\s+projects\s+p/i);
    expect(lookup.sql).toMatch(/p\.user_id\s*=\s*\?/i);
    expect(lookup.sql).toMatch(/source_generation\s*=\s*\?/i);
    expect(lookup.sql).toMatch(/provider\s*=\s*\?/i);
    expect(lookup.sql).toMatch(/status\s*=\s*'completed'/i);
    expect(lookup.values).toEqual(['p1', 3, 'background', 'qualified-provider', 'u1']);
  });

  it('returns an existing active row instead of creating a duplicate claim', async () => {
    const pending = { ...completedRow, id: 'stem-pending', status: 'pending', object_key: null };
    const db = new QueueDb([{ id: 'p1' }, pending]);
    const repo = new AudioStemRepository(db, () => 'unused-id');

    await expect(repo.begin('p1', 'u1', 3, 'background', 'qualified-provider', 'v1')).resolves.toMatchObject({
      id: 'stem-pending', status: 'pending', objectKey: null,
    });
    expect(db.calls.some((call) => /INSERT\s+INTO\s+project_audio_stems/i.test(call.sql))).toBe(false);
  });

  it('permits a new pending retry after a failed row', async () => {
    const failed = { ...completedRow, id: 'stem-failed', status: 'failed', object_key: null, error_code: 'PROVIDER_FAILED', error_message: 'failed' };
    const db = new QueueDb([failed, { id: 'p1' }, null]);
    let nextId = 1;
    const repo = new AudioStemRepository(db, () => `retry-${nextId++}`);

    await repo.fail('p1', 'stem-failed', 'u1', 'PROVIDER_FAILED', 'failed');
    const retry = await repo.begin('p1', 'u1', 3, 'background', 'qualified-provider', 'v1');
    expect(retry).toMatchObject({ id: 'retry-1', status: 'pending', sourceGeneration: 3 });

    const activeLookup = db.calls.find((call) => /FROM\s+project_audio_stems\s+s/i.test(call.sql) && /status\s+IN/i.test(call.sql));
    expect(activeLookup?.sql).toMatch(/status\s+IN\s*\(\s*'pending'\s*,\s*'completed'\s*\)/i);
    expect(db.calls.some((call) => /INSERT\s+INTO\s+project_audio_stems/i.test(call.sql))).toBe(true);
  });

  it('rejects a completed artifact outside the canonical project/source/provider prefix', async () => {
    const db = new QueueDb([completedRow]);
    const repo = new AudioStemRepository(db);

    await expect(repo.complete(
      'p1', 'stem-1', 'u1', 'projects/other/stems/3/qualified-provider/background.wav', 'v2',
    )).rejects.toThrow('Audio stem object key is outside the canonical project/source/provider prefix.');
    expect(db.calls.some((call) => /UPDATE\s+project_audio_stems/i.test(call.sql))).toBe(false);
  });

  it('persists a valid canonical completed artifact and excludes invalidated rows from reuse', async () => {
    const db = new QueueDb([completedRow, null]);
    const repo = new AudioStemRepository(db);

    await repo.complete('p1', 'stem-1', 'u1', 'projects/p1/stems/3/qualified-provider/background.wav', 'v2');
    expect(db.calls.some((call) => /SET\s+status\s*=\s*'completed'/i.test(call.sql))).toBe(true);

    await expect(repo.latestCompleted('p1', 'u1', 4, 'background', 'qualified-provider')).resolves.toBeNull();
    const latestLookup = db.calls.at(-1);
    expect(latestLookup?.sql).toMatch(/status\s*=\s*'completed'/i);
  });
});
