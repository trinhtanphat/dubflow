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
                rows.push({ id, user_id: userId, project_id: projectId, job_id: jobId, kind, units, provider, phase, operation_key: operationKey, cost_basis: 0, created_at: '2026-09-05T00:00:00Z' });
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
              return (values[0] === 'u1' ? { credit_balance: 50000 } : null) as T | null;
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
            return { results: rows.filter((row) => row.user_id === values[0] && row.phase === 'completed') as T[] };
          },
        };
      },
    },
  };
}

const base = {
  userId: 'u1', projectId: 'p1', jobId: 'j1', kind: 'asr_audio_second' as const,
  units: 75.125, provider: 'deepgram-nova-3', phase: 'completed' as const,
  operationKey: 'job:j1:retry:0:asr:chunk-1:deepgram-nova-3',
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

  it('fails closed when the same operation phase reappears with different units', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await repo.record(base);
    await expect(repo.record({ ...base, units: 80 })).rejects.toThrow(/collision/i);
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0].units).toBe(75.125);
  });

  it('keeps started and completed as separate phases and supports canonical lookup', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await repo.record({ ...base, phase: 'started' });
    const completed = await repo.record(base);
    expect(memory.rows.map((row) => row.phase).sort()).toEqual(['completed', 'started']);
    await expect(repo.getByOperation(base.operationKey, 'completed')).resolves.toEqual(completed);
    await expect(repo.getByOperation(base.operationKey, 'started')).resolves.toMatchObject({ phase: 'started' });
    await expect(repo.getByOperation('missing', 'completed')).resolves.toBeNull();
  });

  it('supports project-scoped audio separation minutes as a first-class canonical usage kind', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    const operationKey = 'project:p1:source:3:separation:demucs-container:sha256:8726e21a';
    await repo.record({
      userId: 'u1', projectId: 'p1', jobId: 'sep-job', kind: 'audio_separation_minute',
      units: 1.5, provider: 'demucs-container', phase: 'started', operationKey,
    });
    await repo.record({
      userId: 'u1', projectId: 'p1', jobId: 'sep-job', kind: 'audio_separation_minute',
      units: 1.5, provider: 'demucs-container', phase: 'completed', operationKey,
    });
    await expect(repo.summarizeForProject('p1', 'u1')).resolves.toMatchObject({
      totals: { audioSeparationMinutes: 1.5 },
      providers: { 'demucs-container': { audioSeparationMinutes: 1.5 } },
    });
  });

  it('summarizes completed usage only in canonical base units with provider precision', async () => {
    const memory = usageDb();
    const repo = new UsageRepository(memory.db);
    await repo.record({ ...base, phase: 'started' });
    await repo.record(base);
    await repo.record({ ...base, kind: 'translation_character', units: 17, provider: 'workers-ai', operationKey: 'job:j1:retry:0:translation:batch-0:workers-ai' });
    await repo.record({ ...base, kind: 'tts_audio_second', units: 3.125, provider: 'elevenlabs', operationKey: 'job:j1:retry:0:tts:s1:elevenlabs' });
    await repo.record({ ...base, kind: 'render_second', units: 142.375, provider: 'ffmpeg-container', operationKey: 'job:j1:retry:0:render:final:ffmpeg-container' });

    await expect(repo.summarizeForUser('u1')).resolves.toEqual({
      totals: { asrAudioSeconds: 75.125, translationCharacters: 17, ttsAudioSeconds: 3.125, renderSeconds: 142.375, audioSeparationMinutes: 0 },
      providers: {
        'deepgram-nova-3': { asrAudioSeconds: 75.125, translationCharacters: 0, ttsAudioSeconds: 0, renderSeconds: 0, audioSeparationMinutes: 0 },
        'workers-ai': { asrAudioSeconds: 0, translationCharacters: 17, ttsAudioSeconds: 0, renderSeconds: 0, audioSeparationMinutes: 0 },
        elevenlabs: { asrAudioSeconds: 0, translationCharacters: 0, ttsAudioSeconds: 3.125, renderSeconds: 0, audioSeparationMinutes: 0 },
        'ffmpeg-container': { asrAudioSeconds: 0, translationCharacters: 0, ttsAudioSeconds: 0, renderSeconds: 142.375, audioSeparationMinutes: 0 },
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
    const repo = new UsageRepository(usageDb().db);
    await expect(repo.getCreditBalance('u1')).resolves.toBe(50000);
  });

  it('rejects invalid units and empty operation keys', async () => {
    const repo = new UsageRepository(usageDb().db);
    await expect(repo.record({ ...base, units: Number.NaN })).rejects.toThrow(/units/i);
    await expect(repo.record({ ...base, operationKey: '   ' })).rejects.toThrow(/operation/i);
  });
});
