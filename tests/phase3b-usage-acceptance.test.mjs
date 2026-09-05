import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const [usage, pipeline, exportPipeline, migration, usageRoutes, usageApi, usagePanel] = await Promise.all([
  source('worker/src/db/usage.ts'),
  source('worker/src/workflows/pipeline.ts'),
  source('worker/src/workflows/exportPipeline.ts'),
  source('migrations/0005_usage_event_idempotency.sql'),
  source('worker/src/routes/usage.ts'),
  source('src/features/projects/usageApi.ts'),
  source('src/features/projects/UsageSummaryPanel.tsx'),
]);

test('Phase 3B uses canonical seconds-based usage kinds and summary fields', () => {
  for (const kind of ['asr_audio_second', 'translation_character', 'tts_audio_second', 'render_second']) {
    assert.match(usage, new RegExp(kind));
  }
  for (const field of ['asrAudioSeconds', 'translationCharacters', 'ttsAudioSeconds', 'renderSeconds']) {
    assert.match(usage, new RegExp(field));
    assert.match(usageApi, new RegExp(field));
  }
  assert.doesNotMatch(usage, /asr_audio_minute|tts_character|render_minute/);
});

test('Phase 3B meters provider work in canonical units with retry-scoped operation keys', () => {
  assert.match(pipeline, /chunk\.durationMs\s*\/\s*1000/);
  assert.match(pipeline, /kind:\s*'asr_audio_second'/);
  assert.match(pipeline, /translation_character/);
  assert.match(pipeline, /retry:\$\{retryCount\}/);

  assert.match(exportPipeline, /metadata\.durationMs\s*\/\s*1000/);
  assert.match(exportPipeline, /Number\(project\.durationMs\)\s*\/\s*1000/);
  assert.match(exportPipeline, /kind:\s*'tts_audio_second'/);
  assert.match(exportPipeline, /kind:\s*'render_second'/);
  assert.match(exportPipeline, /getByOperation\(ttsKey,\s*'started'\)/);
  assert.match(exportPipeline, /getByOperation\(ttsKey,\s*'completed'\)/);
});

test('Phase 3B usage writes are idempotent, completed-only for totals, and credits stay read-only', () => {
  assert.match(migration, /UNIQUE INDEX[\s\S]*operation_key,\s*phase/i);
  assert.match(usage, /INSERT OR IGNORE INTO usage_events/);
  assert.match(usage, /cost_basis\)\s*\n\s*VALUES \([^\n]+, 0\)/);
  assert.match(usage, /phase = 'completed'/);
  assert.match(usage, /SELECT credit_balance FROM users/);
  assert.doesNotMatch(usage, /UPDATE\s+users[\s\S]{0,200}credit_balance/i);
  assert.doesNotMatch(usage, /SET\s+credit_balance/i);
  assert.doesNotMatch(usage, /credit_balance\s*=\s*credit_balance\s*[-+]/i);
});

test('Phase 3B summaries derive identity on the server and dashboard remains informational', () => {
  assert.match(usageRoutes, /getCurrentUserId\(\)/);
  assert.match(usageRoutes, /PROJECT_NOT_FOUND/);
  assert.match(usageRoutes, /USAGE_SUMMARY_FAILED/);
  assert.match(usageApi, /api\/usage/);
  assert.match(usageApi, /api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/usage/);
  assert.match(usagePanel, /Credits nội bộ/);
  assert.doesNotMatch(usagePanel, /USD|\$|Thanh toán|Nâng cấp/);
});
