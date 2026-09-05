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

test('Phase 3C config reserves five distinct one-minute rate limiter namespaces', () => {
  const byName = Object.fromEntries((config.ratelimits ?? []).map((entry) => [entry.name, entry]));
  assert.equal(byName.RATE_LIMIT_PROCESS?.simple?.limit, 4);
  assert.equal(byName.RATE_LIMIT_EXPORT?.simple?.limit, 4);
  assert.equal(byName.RATE_LIMIT_TRANSLATE?.simple?.limit, 30);
  assert.equal(byName.RATE_LIMIT_VOICE?.simple?.limit, 30);
  assert.equal(byName.RATE_LIMIT_UPLOAD?.simple?.limit, 20);

  const entries = [
    byName.RATE_LIMIT_PROCESS,
    byName.RATE_LIMIT_EXPORT,
    byName.RATE_LIMIT_TRANSLATE,
    byName.RATE_LIMIT_VOICE,
    byName.RATE_LIMIT_UPLOAD,
  ];
  assert.ok(entries.every((entry) => entry?.simple?.period === 60));
  assert.equal(new Set(entries.map((entry) => entry?.namespace_id)).size, 5);
});
