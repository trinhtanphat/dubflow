import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';

const usage = read('worker/src/db/usage.ts');
const dubbingPipeline = read('worker/src/workflows/pipeline.ts');
const exportPipeline = read('worker/src/workflows/exportPipeline.ts');
const usageRoutes = read('worker/src/routes/usage.ts');
const migration = read('migrations/0005_usage_event_idempotency.sql');
const usagePanel = read('src/features/projects/UsageSummaryPanel.tsx');

test('Phase 3B acceptance: canonical storage and API units stay seconds/characters', () => {
  for (const kind of [
    'asr_audio_second',
    'translation_character',
    'tts_audio_second',
    'render_second',
  ]) {
    assert.match(usage, new RegExp(kind));
  }
  for (const field of [
    'asrAudioSeconds',
    'translationCharacters',
    'ttsAudioSeconds',
    'renderSeconds',
  ]) {
    assert.match(usage, new RegExp(field));
  }
  assert.doesNotMatch(usage, /asr_audio_minute|tts_character|render_minute|asrAudioMinutes|renderMinutes/);
});

test('Phase 3B acceptance: completed summaries are durable and replay-idempotent', () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_operation_phase[\s\S]*operation_key, phase/);
  assert.match(usage, /INSERT OR IGNORE INTO usage_events/);
  assert.match(usage, /WHERE user_id = \? AND phase = 'completed'/);
  assert.match(usage, /ue\.phase = 'completed'/);
  assert.match(dubbingPipeline, /job:\$\{jobId\}:retry:\$\{retryCount\}:\$\{stage\}:\$\{item\}:\$\{provider\}/);
  assert.match(exportPipeline, /job:\$\{jobId\}:retry:\$\{retryCount\}:\$\{stage\}:\$\{item\}:\$\{provider\}/);
});

test('Phase 3B acceptance: ASR, TTS and render durations are metered in seconds', () => {
  assert.match(dubbingPipeline, /durationMs\s*\/\s*1000/);
  assert.match(dubbingPipeline, /kind: 'asr_audio_second'/);
  assert.match(dubbingPipeline, /kind: 'translation_character'/);
  assert.match(exportPipeline, /metadata\.durationMs\s*\/\s*1000/);
  assert.match(exportPipeline, /kind: 'tts_audio_second'/);
  assert.match(exportPipeline, /Number\(project\.durationMs\)\s*\/\s*1000/);
  assert.match(exportPipeline, /kind: 'render_second'/);
  assert.doesNotMatch(dubbingPipeline, /asr_audio_minute|render_minute/);
  assert.doesNotMatch(exportPipeline, /tts_character|render_minute/);
});

test('Phase 3B acceptance: TTS recovery probes durable audio without forced regeneration', () => {
  assert.match(exportPipeline, /if \(objectKey\)[\s\S]*if \(started && !completed\)[\s\S]*probeTtsSeconds/);
  assert.match(exportPipeline, /deps\.usage\.getByOperation\(ttsKey, 'started'\)/);
  assert.match(exportPipeline, /deps\.usage\.getByOperation\(ttsKey, 'completed'\)/);
  assert.match(exportPipeline, /deps\.voice\.generate\(input\)/);
});

test('Phase 3B acceptance: credits remain informational and never become a billing gate', () => {
  assert.match(usage, /SELECT credit_balance FROM users/);
  assert.match(usage, /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, 0\)/);
  assert.doesNotMatch(usage, /UPDATE\s+users[\s\S]*credit_balance/i);
  assert.doesNotMatch(usage, /credit_balance\s*=\s*credit_balance\s*[-+]/i);
  assert.doesNotMatch(usageRoutes, /402|PAYMENT|QUOTA|UPGRADE/i);
  assert.doesNotMatch(usagePanel, /upgrade|nâng cấp|mua thêm|thanh toán|pricing/i);
});

test('Phase 3B acceptance: usage summaries stay authorized and server-derived', () => {
  assert.match(usageRoutes, /getCurrentUserId\(\)/);
  assert.match(usageRoutes, /summarizeForUser\(userId\)/);
  assert.match(
    usageRoutes,
    /summarizeForProject\([\s\S]*c\.req\.param\('id'\)[\s\S]*getCurrentUserId\(\)[\s\S]*\)/,
  );
  assert.match(usageRoutes, /PROJECT_NOT_FOUND/);
  assert.doesNotMatch(usageRoutes, /c\.req\.(query|json)[\s\S]*userId/);
});
