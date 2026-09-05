import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { creditsForUsage } from '../src/domain/usage';

type UsageRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  job_id: string | null;
  kind: string;
  units: number;
  provider: string;
  cost_basis: number;
  credits: number;
  idempotency_key: string | null;
  created_at: string;
};

function repositoryDb(options?: { allocatedCredits?: number; summaryRows?: UsageRow[] }) {
  const events = new Map<string, UsageRow>();
  const allocatedCredits = options?.allocatedCredits ?? 50_000;
  const summaryRows = options?.summaryRows ?? [];

  return {
    events,
    db: {
      prepare(statement: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async run() {
            if (statement.includes('INSERT OR IGNORE INTO usage_events')) {
              const [id, userId, projectId, jobId, kind, units, provider, creditRate, credits, idempotencyKey] = values;
              const key = String(idempotencyKey);
              if (events.has(key)) return { meta: { changes: 0 } };
              events.set(key, {
                id: String(id),
                user_id: String(userId),
                project_id: projectId === null ? null : String(projectId),
                job_id: jobId === null ? null : String(jobId),
                kind: String(kind),
                units: Number(units),
                provider: String(provider),
                cost_basis: Number(creditRate),
                credits: Number(credits),
                idempotency_key: key,
                created_at: '2026-09-05T17:00:00Z',
              });
              return { meta: { changes: 1 } };
            }
            throw new Error(`Unexpected run SQL: ${statement}`);
          },
          async first<T>() {
            if (statement.includes('FROM usage_events') && statement.includes('idempotency_key')) {
              return (events.get(String(values[0])) ?? null) as T | null;
            }
            if (statement.includes('FROM users') && statement.includes('credit_balance')) {
              return { credit_balance: allocatedCredits } as T;
            }
            return null;
          },
          async all<T>() {
            if (statement.includes('FROM usage_events') && statement.includes('WHERE user_id = ?')) {
              expect(values).toEqual(['dev-user']);
              return { results: summaryRows as T[] };
            }
            return { results: [] as T[] };
          },
        };
      },
    },
  };
}

describe('Phase 3B usage credits', () => {
  it('converts normalized provider units into internal credits', () => {
    expect(creditsForUsage('asr_audio_seconds', 60)).toEqual({ credits: 10, creditRate: 1 / 6 });
    expect(creditsForUsage('translation_characters', 1000)).toEqual({ credits: 5, creditRate: 1 / 200 });
    expect(creditsForUsage('tts_characters', 1000)).toEqual({ credits: 20, creditRate: 1 / 50 });
    expect(creditsForUsage('render_seconds', 60)).toEqual({ credits: 2, creditRate: 1 / 30 });
  });

  it('rejects empty or non-finite billable usage', () => {
    for (const units of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => creditsForUsage('asr_audio_seconds', units)).toThrow(/positive finite/i);
    }
  });

  it('persists the Phase 3B replay-safe ledger columns and unique idempotency index', () => {
    const migration = readFileSync('migrations/0005_usage_ledger.sql', 'utf8');
    expect(migration).toContain('ADD COLUMN job_id TEXT');
    expect(migration).toContain('ADD COLUMN idempotency_key TEXT');
    expect(migration).toContain('ADD COLUMN credits INTEGER NOT NULL DEFAULT 0');
    expect(migration).toMatch(/CREATE UNIQUE INDEX[\s\S]+usage_events\(idempotency_key\)[\s\S]+WHERE idempotency_key IS NOT NULL/);
  });

  it('returns the canonical existing event when an idempotency key is replayed', async () => {
    const modulePath = '../src/db/' + 'usage';
    const { UsageRepository } = await import(modulePath) as {
      UsageRepository: new (db: unknown) => {
        record(input: {
          userId: string;
          projectId: string | null;
          jobId: string | null;
          kind: 'translation_characters';
          units: number;
          provider: string;
          idempotencyKey: string;
        }): Promise<{ event: { id: string; credits: number; creditRate: number; idempotencyKey: string | null }; inserted: boolean }>;
      };
    };
    const state = repositoryDb();
    const repository = new UsageRepository(state.db);
    const input = {
      userId: 'dev-user', projectId: 'p1', jobId: 'j1',
      kind: 'translation_characters' as const, units: 400, provider: 'workers-ai',
      idempotencyKey: 'job:j1:attempt:0:translation:0',
    };

    const first = await repository.record(input);
    const replay = await repository.record(input);

    expect(first.inserted).toBe(true);
    expect(first.event).toMatchObject({ credits: 2, creditRate: 1 / 200, idempotencyKey: input.idempotencyKey });
    expect(replay).toEqual({ event: first.event, inserted: false });
    expect(state.events.size).toBe(1);
  });

  it('derives account credits and provider totals from append-only events', async () => {
    const modulePath = '../src/db/' + 'usage';
    const { UsageRepository } = await import(modulePath) as {
      UsageRepository: new (db: unknown) => {
        summaryForUser(userId: string): Promise<{
          allocatedCredits: number;
          usedCredits: number;
          remainingCredits: number;
          overageCredits: number;
          totals: Array<{ kind: string; units: number; credits: number }>;
          providers: Array<{ provider: string; kind: string; units: number; credits: number }>;
        }>;
      };
    };
    const rows: UsageRow[] = [
      { id: 'u1', user_id: 'dev-user', project_id: 'p1', job_id: 'j1', kind: 'asr_audio_seconds', units: 12, provider: 'deepgram-nova-3', cost_basis: 1 / 6, credits: 2, idempotency_key: 'k1', created_at: '2026-09-05T17:00:00Z' },
      { id: 'u2', user_id: 'dev-user', project_id: 'p1', job_id: 'j1', kind: 'translation_characters', units: 400, provider: 'workers-ai', cost_basis: 1 / 200, credits: 2, idempotency_key: 'k2', created_at: '2026-09-05T17:00:01Z' },
      { id: 'u3', user_id: 'dev-user', project_id: 'p1', job_id: null, kind: 'translation_characters', units: 200, provider: 'google', cost_basis: 1 / 200, credits: 1, idempotency_key: null, created_at: '2026-09-05T17:00:02Z' },
    ];
    const repository = new UsageRepository(repositoryDb({ allocatedCredits: 3, summaryRows: rows }).db);

    const summary = await repository.summaryForUser('dev-user');

    expect(summary).toMatchObject({ allocatedCredits: 3, usedCredits: 5, remainingCredits: 0, overageCredits: 2 });
    expect(summary.totals).toEqual([
      { kind: 'asr_audio_seconds', units: 12, credits: 2 },
      { kind: 'translation_characters', units: 600, credits: 3 },
    ]);
    expect(summary.providers).toEqual([
      { provider: 'deepgram-nova-3', kind: 'asr_audio_seconds', units: 12, credits: 2 },
      { provider: 'google', kind: 'translation_characters', units: 200, credits: 1 },
      { provider: 'workers-ai', kind: 'translation_characters', units: 400, credits: 2 },
    ]);
  });
});
