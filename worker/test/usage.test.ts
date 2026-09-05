import { describe, expect, it } from 'vitest';
import { UsageRepository, type UsageEvent } from '../src/db/usage';

type Row = {
  id: string;
  user_id: string;
  project_id: string;
  job_id: string;
  kind: UsageEvent['kind'];
  units: number;
  provider: string;
  phase: UsageEvent['phase'];
  operation_key: string;
  cost_basis: number;
  created_at: string;
};

function usageDb() {
  const rows: Row[] = [];
  const projectOwners = new Map([['p1', 'u1'], ['p2', 'u2']]);
  return {
    rows,
    db: {
      prepare(statement: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async run() {
            if (statement.includes('INSERT OR IGNORE INTO usage_events')) {
              const [id, userId, projectId, jobId, kind, units, provider, phase, operationKey] = values as [string, string, string, string, Row['kind'], number, string, Row['phase'], string];
              const duplicate = rows.some((row) => row.operation_key === operationKey && row.phase === phase);
              if (!duplicate) {
                rows.push({
                  id,
                  user_id: userId,
                  project_id: projectId,
                  job_id: jobId,
                  kind,
                  units,
                  provider,
                  phase,
                  operation_key: operationKey,
                  cost_basis: 0,
                  created_at: '2026-09-05T00:00:00Z',
                });
              }
              return { meta: { changes: duplicate ? 0 : 1 } };
            }
            return { meta: { changes: 0 } };
          },
          async first<T>() {
            if (statement.includes('WHERE operation_key = ? AND phase = ?')) {
              const [operationKey, phase] = values;
              return (rows.find((row) => row.operation_key === operationKey && row.phase === phase) ?? null) as T | null;
            }
            if (statement.includes('SELECT credit_balance')) {
              const [userId] = values;
              return (userId === 'u1' ? { credit_balance: 50000 } : null) as T | null;
            }
            if (statement.includes('SELECT id FROM projects')) {
              const [projectId, userId] = values;
              return (projectOwners.get(String(projectId)) === userId ? { id: projectId } : null) as T | null;
            }
            return null;
          },
          async all<T>() {
            if (!statement.includes('FROM usage_events')) return { results: [] as T[] };
            if (statement.includes('INNER JOIN projects')) {
              const [projectId, userId] = values as [string, string];
              if (projectOwners.get(projectId) !== userId) return { results: [] as T[] };
              return { results: rows.filter((row) => row.project_id === projectId && row.phase === 'completed') as T[] };
            }
            const [userId] = values as [string];
            return { results: rows.filter((row) => row.user_id === userId && row.phase === 'completed') as T[] };
          },
        };
      },
    },
  };
}

const base = {
  userId: 'u1',
  projectId: 'p1',
  jobId: 'j1',
  kind: 'asr_audio_minute' as const,
  units: 1.25,
  provider: 'deepgram',
  phase: 'completed' as const,
  operationKey: 'job:j1:retry:0:asr:chunk-1',
};

describe('UsageRepository', () => {
  it('deduplicates the same operation phase and returns the canonical event', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    const first = await repo.record(base);
    const second = await repo.record(base);

    expect(second.id).toBe(first.id);
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0].cost_basis).toBe(0);
  });

  it('keeps started and completed as separate idempotent phases', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await repo.record({ ...base, phase: 'started' });
    await repo.record(base);

    expect(memory.rows.map((row) => row.phase).sort()).toEqual(['completed', 'started']);
  });

  it('summarizes completed usage only with provider precision', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await repo.record({ ...base, phase: 'started' });
    await repo.record(base);
    await repo.record({
      ...base,
      kind: 'translation_character',
      units: 17,
      provider: 'workers-ai',
      operationKey: 'job:j1:retry:0:translation:batch-0:provider:workers-ai',
    });
    await repo.record({
      ...base,
      kind: 'render_minute',
      units: 2.375,
      provider: 'ffmpeg-container',
      operationKey: 'job:j1:retry:0:render:final',
    });

    await expect(repo.summarizeForUser('u1')).resolves.toEqual({
      totals: {
        asrAudioMinutes: 1.25,
        translationCharacters: 17,
        ttsCharacters: 0,
        renderMinutes: 2.375,
      },
      providers: {
        deepgram: { asrAudioMinutes: 1.25, translationCharacters: 0, ttsCharacters: 0, renderMinutes: 0 },
        'workers-ai': { asrAudioMinutes: 0, translationCharacters: 17, ttsCharacters: 0, renderMinutes: 0 },
        'ffmpeg-container': { asrAudioMinutes: 0, translationCharacters: 0, ttsCharacters: 0, renderMinutes: 2.375 },
      },
    });
  });

  it('hides project usage from another user', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await repo.record(base);

    await expect(repo.summarizeForProject('p1', 'u2')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });

  it('reads the internal credit balance without mutating it', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await expect(repo.getCreditBalance('u1')).resolves.toBe(50000);
  });

  it('rejects invalid units and empty operation keys', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await expect(repo.record({ ...base, units: Number.NaN })).rejects.toThrow(/units/i);
    await expect(repo.record({ ...base, operationKey: '   ' })).rejects.toThrow(/operation/i);
  });
});
