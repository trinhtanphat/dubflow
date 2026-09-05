import { apiFetch } from '../../lib/api/client';

export type UsageTotals = {
  asrAudioSeconds: number;
  translationCharacters: number;
  ttsAudioSeconds: number;
  renderSeconds: number;
};

export type UsageSummary = {
  totals: UsageTotals;
  providers: Record<string, UsageTotals>;
};

export type UsageSummaryResponse = UsageSummary & {
  creditBalance: number;
};

export function getUsageSummary() {
  return apiFetch<UsageSummaryResponse>('/api/usage');
}

export function getProjectUsageSummary(projectId: string) {
  return apiFetch<UsageSummary>(`/api/projects/${encodeURIComponent(projectId)}/usage`);
}
