export type UsageKind =
  | 'asr_audio_seconds'
  | 'translation_characters'
  | 'tts_characters'
  | 'render_seconds';

const CREDIT_DIVISORS: Record<UsageKind, number> = {
  asr_audio_seconds: 6,
  translation_characters: 200,
  tts_characters: 50,
  render_seconds: 30,
};

export type UsageCreditCharge = {
  credits: number;
  creditRate: number;
};

export type UsageEvent = {
  id: string;
  userId: string;
  projectId: string | null;
  jobId: string | null;
  kind: UsageKind;
  units: number;
  provider: string;
  creditRate: number;
  credits: number;
  idempotencyKey: string | null;
  createdAt: string;
};

export type RecordUsageInput = {
  userId: string;
  projectId: string | null;
  jobId: string | null;
  kind: UsageKind;
  units: number;
  provider: string;
  idempotencyKey?: string | null;
};

export type UsageSummary = {
  allocatedCredits: number;
  usedCredits: number;
  remainingCredits: number;
  overageCredits: number;
  totals: Array<{ kind: UsageKind; units: number; credits: number }>;
  providers: Array<{ provider: string; kind: UsageKind; units: number; credits: number }>;
};

export function creditsForUsage(kind: UsageKind, units: number): UsageCreditCharge {
  if (!Number.isFinite(units) || units <= 0) {
    throw new Error('Billable usage units must be a positive finite number.');
  }

  const divisor = CREDIT_DIVISORS[kind];
  if (!divisor) throw new Error(`Unsupported usage kind: ${kind}`);

  return {
    credits: Math.max(1, Math.ceil(units / divisor)),
    creditRate: 1 / divisor,
  };
}
