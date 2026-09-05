import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('Phase 3C config binds Analytics Engine to the canonical operational dataset', () => {
  assert.deepEqual(config.analytics_engine_datasets, [
    { binding: 'ANALYTICS', dataset: 'dubflow_events' },
  ]);
});

test('Phase 3C config enables full invocation logs, query redaction and five-percent traces', () => {
  assert.equal(config.observability?.enabled, true);
  assert.deepEqual(config.observability?.logs, {
    enabled: true,
    invocation_logs: true,
    head_sampling_rate: 1,
  });
  assert.equal(config.observability?.redact_query_string, true);
  assert.deepEqual(config.observability?.traces, {
    enabled: true,
    head_sampling_rate: 0.05,
  });
});
