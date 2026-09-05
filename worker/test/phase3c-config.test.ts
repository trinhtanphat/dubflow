import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type WranglerConfig = {
  analytics_engine_datasets?: Array<{ binding?: string; dataset?: string }>;
  observability?: {
    enabled?: boolean;
    redact_query_string?: boolean;
    logs?: { enabled?: boolean; invocation_logs?: boolean; head_sampling_rate?: number };
    traces?: { enabled?: boolean; head_sampling_rate?: number };
  };
};

function readConfig(): WranglerConfig {
  return JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')) as WranglerConfig;
}

describe('Phase 3C Cloudflare observability config', () => {
  it('binds Analytics Engine to the canonical operational dataset', () => {
    expect(readConfig().analytics_engine_datasets).toEqual([
      { binding: 'ANALYTICS', dataset: 'dubflow_events' },
    ]);
  });

  it('enables full invocation logs, query redaction and five-percent traces', () => {
    const observability = readConfig().observability;
    expect(observability?.enabled).toBe(true);
    expect(observability?.logs).toMatchObject({
      enabled: true,
      invocation_logs: true,
      head_sampling_rate: 1,
    });
    expect(observability?.redact_query_string).toBe(true);
    expect(observability?.traces).toMatchObject({
      enabled: true,
      head_sampling_rate: 0.05,
    });
  });
});
