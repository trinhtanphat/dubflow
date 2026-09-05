import { creditsForUsage, type RecordUsageInput, type UsageEvent, type UsageKind, type UsageSummary } from '../domain/usage';
import type { D1DatabaseLike } from './projects';

type UsageRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  job_id: string | null;
  kind: UsageKind;
  units: number;
  provider: string;
  cost_basis: number;
  credits: number;
  idempotency_key: string | null;
  created_at: string;
};

type CreditRow = { credit_balance: number };

export interface UsageStore {
  record(input: RecordUsageInput): Promise<{ event: UsageEvent; inserted: boolean }>;
  summaryForUser(userId: string): Promise<UsageSummary>;
}

function mapUsage(row: UsageRow): UsageEvent {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind,
    units: Number(row.units),
    provider: row.provider,
    creditRate: Number(row.cost_basis),
    credits: Number(row.credits),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function changes(result: { meta?: { changes?: number }; changes?: number }): number {
  return Number(result.meta?.changes ?? result.changes ?? 0);
}

export class UsageRepository implements UsageStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async record(input: RecordUsageInput): Promise<{ event: UsageEvent; inserted: boolean }> {
    const provider = input.provider.trim();
    if (!provider) throw new Error('Usage provider is required.');
    const { credits, creditRate } = creditsForUsage(input.kind, input.units);
    const id = crypto.randomUUID();
    const idempotencyKey = input.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const result = await this.db.prepare(`
        INSERT OR IGNORE INTO usage_events (
          id, user_id, project_id, job_id, kind, units, provider, cost_basis, credits, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.userId,
        input.projectId,
        input.jobId,
        input.kind,
        input.units,
        provider,
        creditRate,
        credits,
        idempotencyKey,
      ).run();

      const row = await this.db.prepare(`
        SELECT id, user_id, project_id, job_id, kind, units, provider, cost_basis, credits,
               idempotency_key, created_at
        FROM usage_events
        WHERE idempotency_key = ?
        LIMIT 1
      `).bind(idempotencyKey).first<UsageRow>();
      if (!row) throw new Error('Usage event could not be read after persistence.');
      return { event: mapUsage(row), inserted: changes(result) > 0 };
    }

    await this.db.prepare(`
      INSERT INTO usage_events (
        id, user_id, project_id, job_id, kind, units, provider, cost_basis, credits, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      id,
      input.userId,
      input.projectId,
      input.jobId,
      input.kind,
      input.units,
      provider,
      creditRate,
      credits,
    ).run();

    return {
      inserted: true,
      event: {
        id,
        userId: input.userId,
        projectId: input.projectId,
        jobId: input.jobId,
        kind: input.kind,
        units: input.units,
        provider,
        creditRate,
        credits,
        idempotencyKey: null,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async summaryForUser(userId: string): Promise<UsageSummary> {
    const allocation = await this.db.prepare(`
      SELECT credit_balance
      FROM users
      WHERE id = ?
      LIMIT 1
    `).bind(userId).first<CreditRow>();
    const allocatedCredits = Math.max(0, Number(allocation?.credit_balance ?? 0));

    const result = await this.db.prepare(`
      SELECT id, user_id, project_id, job_id, kind, units, provider, cost_basis, credits,
             idempotency_key, created_at
      FROM usage_events
      WHERE user_id = ?
      ORDER BY created_at ASC, id ASC
    `).bind(userId).all<UsageRow>();
    const rows = result.results ?? [];

    const totalMap = new Map<UsageKind, { units: number; credits: number }>();
    const providerMap = new Map<string, { provider: string; kind: UsageKind; units: number; credits: number }>();
    let usedCredits = 0;

    for (const row of rows) {
      const units = Number(row.units);
      const rowCredits = Math.max(0, Number(row.credits));
      usedCredits += rowCredits;

      const total = totalMap.get(row.kind) ?? { units: 0, credits: 0 };
      total.units += units;
      total.credits += rowCredits;
      totalMap.set(row.kind, total);

      const providerKey = `${row.provider}\u0000${row.kind}`;
      const provider = providerMap.get(providerKey) ?? {
        provider: row.provider,
        kind: row.kind,
        units: 0,
        credits: 0,
      };
      provider.units += units;
      provider.credits += rowCredits;
      providerMap.set(providerKey, provider);
    }

    return {
      allocatedCredits,
      usedCredits,
      remainingCredits: Math.max(0, allocatedCredits - usedCredits),
      overageCredits: Math.max(0, usedCredits - allocatedCredits),
      totals: [...totalMap.entries()]
        .map(([kind, value]) => ({ kind, ...value }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      providers: [...providerMap.values()]
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind)),
    };
  }
}
