import type { D1DatabaseLike } from './projects';

export type UsageKind =
  | 'asr_audio_second'
  | 'translation_character'
  | 'tts_audio_second'
  | 'stem_separation_audio_second'
  | 'render_second';

export type UsagePhase = 'started' | 'completed';

export type UsageEvent = {
  id: string;
  userId: string;
  projectId: string;
  jobId: string;
  kind: UsageKind;
  units: number;
  provider: string;
  phase: UsagePhase;
  operationKey: string;
  costBasis: number;
  createdAt: string;
};

export type UsageRecordInput = Omit<UsageEvent, 'id' | 'costBasis' | 'createdAt'>;

export type UsageTotals = {
  asrAudioSeconds: number;
  translationCharacters: number;
  ttsAudioSeconds: number;
  stemSeparationAudioSeconds: number;
  renderSeconds: number;
};

export type UsageSummary = {
  totals: UsageTotals;
  providers: Record<string, UsageTotals>;
};

export interface UsageStore {
  record(input: UsageRecordInput): Promise<UsageEvent>;
  getByOperation(operationKey: string, phase: UsagePhase): Promise<UsageEvent | null>;
  summarizeForUser(userId: string): Promise<UsageSummary>;
  summarizeForProject(projectId: string, userId: string): Promise<UsageSummary>;
  getCreditBalance(userId: string): Promise<number>;
}

export class UsageAccessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UsageAccessError';
  }
}

type UsageRow = {
  id: string;
  user_id: string;
  project_id: string;
  job_id: string;
  kind: UsageKind;
  units: number;
  provider: string;
  phase: UsagePhase;
  operation_key: string;
  cost_basis: number;
  created_at: string;
};

type UsageAggregateRow = Pick<UsageRow, 'kind' | 'units' | 'provider'>;
type TableInfoRow = { name: string };

const USAGE_COLUMNS = `id, user_id, project_id, job_id, kind, units, provider, phase, operation_key, cost_basis, created_at`;
const USAGE_KINDS = new Set<UsageKind>([
  'asr_audio_second',
  'translation_character',
  'tts_audio_second',
  'stem_separation_audio_second',
  'render_second',
]);

function fromRow(row: UsageRow): UsageEvent {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind,
    units: Number(row.units),
    provider: row.provider,
    phase: row.phase,
    operationKey: row.operation_key,
    costBasis: Number(row.cost_basis ?? 0),
    createdAt: row.created_at,
  };
}

function emptyTotals(): UsageTotals {
  return {
    asrAudioSeconds: 0,
    translationCharacters: 0,
    ttsAudioSeconds: 0,
    stemSeparationAudioSeconds: 0,
    renderSeconds: 0,
  };
}

function addUnits(totals: UsageTotals, kind: UsageKind, units: number): void {
  if (kind === 'asr_audio_second') totals.asrAudioSeconds += units;
  else if (kind === 'translation_character') totals.translationCharacters += units;
  else if (kind === 'tts_audio_second') totals.ttsAudioSeconds += units;
  else if (kind === 'stem_separation_audio_second') totals.stemSeparationAudioSeconds += units;
  else totals.renderSeconds += units;
}

function summarize(rows: UsageAggregateRow[]): UsageSummary {
  const totals = emptyTotals();
  const providers: Record<string, UsageTotals> = {};
  for (const row of rows) {
    const units = Number(row.units);
    if (!USAGE_KINDS.has(row.kind) || !Number.isFinite(units) || units < 0) continue;
    addUnits(totals, row.kind, units);
    const provider = row.provider.trim();
    if (!provider) continue;
    if (!providers[provider]) providers[provider] = emptyTotals();
    addUnits(providers[provider], row.kind, units);
  }
  return { totals, providers };
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty.`);
  return trimmed;
}

export class UsageRepository implements UsageStore {
  private usageHasPhasePromise?: Promise<boolean>;

  constructor(private readonly db: D1DatabaseLike) {}

  private async usageHasPhase(): Promise<boolean> {
    if (!this.usageHasPhasePromise) {
      this.usageHasPhasePromise = this.db
        .prepare("PRAGMA table_info('usage_events')")
        .all<TableInfoRow>()
        .then((result) => {
          const rows = result.results ?? [];
          // Existing test doubles and current-schema adapters may not expose
          // table metadata. Preserve current-schema semantics in that case;
          // a real legacy D1 returns its non-empty column list here.
          if (rows.length === 0) return true;
          return rows.some((row) => row.name === 'phase');
        });
    }
    return this.usageHasPhasePromise;
  }

  async getByOperation(operationKey: string, phase: UsagePhase): Promise<UsageEvent | null> {
    const key = nonEmpty(operationKey, 'Operation key');
    const row = await this.db.prepare(
      `SELECT ${USAGE_COLUMNS}
       FROM usage_events
       WHERE operation_key = ? AND phase = ?
       LIMIT 1`,
    ).bind(key, phase).first<UsageRow>();
    return row ? fromRow(row) : null;
  }

  async record(input: UsageRecordInput): Promise<UsageEvent> {
    if (!USAGE_KINDS.has(input.kind)) throw new Error('Usage kind is unsupported.');
    if (input.phase !== 'started' && input.phase !== 'completed') throw new Error('Usage phase is unsupported.');
    if (!Number.isFinite(input.units) || input.units < 0) {
      throw new Error('Usage units must be a non-negative finite number.');
    }
    const userId = nonEmpty(input.userId, 'User id');
    const projectId = nonEmpty(input.projectId, 'Project id');
    const jobId = nonEmpty(input.jobId, 'Job id');
    const provider = nonEmpty(input.provider, 'Provider');
    const operationKey = nonEmpty(input.operationKey, 'Operation key');
    const id = crypto.randomUUID();

    await this.db.prepare(
      `INSERT OR IGNORE INTO usage_events
       (id, user_id, project_id, job_id, kind, units, provider, phase, operation_key, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(
      id,
      userId,
      projectId,
      jobId,
      input.kind,
      input.units,
      provider,
      input.phase,
      operationKey,
    ).run();

    const event = await this.getByOperation(operationKey, input.phase);
    if (!event) throw new Error('Usage event was not persisted.');
    if (
      event.userId !== userId ||
      event.projectId !== projectId ||
      event.jobId !== jobId ||
      event.kind !== input.kind ||
      event.units !== input.units ||
      event.provider !== provider
    ) {
      throw new Error('Usage operation key collision detected.');
    }
    return event;
  }

  async summarizeForUser(userId: string): Promise<UsageSummary> {
    const completedPredicate = await this.usageHasPhase() ? " AND phase = 'completed'" : '';
    const result = await this.db.prepare(
      `SELECT kind, units, provider
       FROM usage_events
       WHERE user_id = ?${completedPredicate}
       ORDER BY created_at ASC, id ASC`,
    ).bind(userId).all<UsageAggregateRow>();
    return summarize(result.results ?? []);
  }

  async summarizeForProject(projectId: string, userId: string): Promise<UsageSummary> {
    const owned = await this.db.prepare(
      `SELECT id FROM projects WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(projectId, userId).first<{ id: string }>();
    if (!owned) throw new UsageAccessError('PROJECT_NOT_FOUND', 'Project not found.');

    const completedPredicate = await this.usageHasPhase() ? " AND ue.phase = 'completed'" : '';
    const result = await this.db.prepare(
      `SELECT ue.kind, ue.units, ue.provider
       FROM usage_events ue
       INNER JOIN projects p ON p.id = ue.project_id
       WHERE ue.project_id = ? AND p.user_id = ?${completedPredicate}
       ORDER BY ue.created_at ASC, ue.id ASC`,
    ).bind(projectId, userId).all<UsageAggregateRow>();
    return summarize(result.results ?? []);
  }

  async getCreditBalance(userId: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT credit_balance FROM users WHERE id = ? LIMIT 1`,
    ).bind(userId).first<{ credit_balance: number }>();
    if (!row) return 0;
    const balance = Number(row.credit_balance);
    return Number.isFinite(balance) && balance >= 0 ? balance : 0;
  }
}
