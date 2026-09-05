import { apiFetch } from '../../lib/api/client';

export type UsageKind =
  | 'asr_audio_seconds'
  | 'translation_characters'
  | 'tts_characters'
  | 'render_seconds';

export type UsageSummary = {
  allocatedCredits: number;
  usedCredits: number;
  remainingCredits: number;
  overageCredits: number;
  totals: Array<{
    kind: UsageKind;
    units: number;
    credits: number;
  }>;
  providers: Array<{
    provider: string;
    kind: UsageKind;
    units: number;
    credits: number;
  }>;
};

export function fetchUsageSummary(): Promise<UsageSummary> {
  return apiFetch<UsageSummary>('/api/usage/summary');
}
