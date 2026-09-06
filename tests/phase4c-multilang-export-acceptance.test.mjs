import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Phase 4C persists bounded target-aware translation dubbing and export state', async () => {
  const migration = await read('migrations/0009_multilang_exports.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS project_targets/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS segment_translations/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS segment_dubs/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS project_exports/i);
  assert.match(migration, /target_language\s+TEXT[^;]*CHECK\s*\(target_language IN \('vi','en','ja','ko','zh'\)\)/is);
  assert.match(migration, /enabled\s+INTEGER[^;]*CHECK\s*\(enabled IN \(0,1\)\)/is);
});

test('Phase 4C exposes one bounded target-language authority and batch limit', async () => {
  const domain = await read('worker/src/domain/target-language.ts');
  assert.match(domain, /SUPPORTED_TARGET_LANGUAGES\s*=\s*\['vi',\s*'en',\s*'ja',\s*'ko',\s*'zh'\]/);
  assert.match(domain, /MAX_BATCH_TARGET_LANGUAGES\s*=\s*4/);
  assert.match(domain, /parseProjectTargetLanguages/);
  assert.match(domain, /fallback[^=]*=\s*'vi'/);
});

test('Phase 4C translation provider contracts accept the bounded target-language type', async () => {
  const types = await read('worker/src/services/translation/types.ts');
  const map = await read('worker/src/services/translation/language-map.ts');
  const workers = await read('worker/src/services/translation/workers-ai.ts');
  assert.match(types, /target:\s*TargetLanguage/);
  assert.match(map, /workersAITargetLanguage/);
  for (const marker of ["vi: 'vietnamese'", "en: 'english'", "ja: 'japanese'", "ko: 'korean'", "zh: 'chinese'"]) {
    assert.match(map, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(workers, /target_lang:\s*workersAITargetLanguage\(target\)/);
  assert.doesNotMatch(workers, /Vietnamese is the only supported target/);
});

test('Phase 4C adds an isolated batch-export limiter without replacing existing lanes', async () => {
  const wrangler = await read('wrangler.jsonc');
  const rateLimit = await read('worker/src/security/rate-limit.ts');
  const env = await read('worker/src/env.ts');
  assert.match(wrangler, /"name": "RATE_LIMIT_BATCH_EXPORT", "namespace_id": "31007", "simple": \{ "limit": 2, "period": 60 \}/);
  for (const binding of ['RATE_LIMIT_PROCESS','RATE_LIMIT_EXPORT','RATE_LIMIT_TRANSLATE','RATE_LIMIT_VOICE','RATE_LIMIT_UPLOAD','RATE_LIMIT_VOICE_CLONE']) {
    assert.match(wrangler, new RegExp(binding));
  }
  assert.match(rateLimit, /'batch-export'/);
  assert.match(env, /RATE_LIMIT_BATCH_EXPORT/);
});

test('Phase 4C uses target-scoped dubbed and export object keys and concrete export sharing', async () => {
  const pipeline = await read('worker/src/workflows/exportPipeline.ts');
  const shares = await read('worker/src/routes/shares.ts');
  assert.match(pipeline, /dubbed\/\$\{targetLanguage\}/);
  assert.match(pipeline, /exports\/\$\{targetLanguage\}/);
  assert.match(shares, /exportId/);
});

test('Phase 4C mounts owner-scoped target and batch export routes', async () => {
  const app = await read('worker/src/app.ts');
  const targets = await read('worker/src/routes/project-targets.ts');
  const batch = await read('worker/src/routes/batch-export.ts');
  assert.match(app, /createProjectTargetRoutes/);
  assert.match(app, /createBatchExportRoutes/);
  assert.match(targets, /\/:id\/targets/);
  assert.match(targets, /parseProjectTargetLanguages/);
  assert.match(batch, /\/:id\/exports\/batch/);
  assert.match(batch, /parseBatchTargetLanguages/);
  assert.match(batch, /enforceRateLimit\(c,\s*'batch-export'/);
});

test('Phase 4C documents source-only qualification and real multi-language production fixture boundary', async () => {
  const status = await read('docs/deployment-status.md');
  assert.match(status, /Phase 4C/i);
  assert.match(status, /multi-language/i);
  assert.match(status, /source\/CI/i);
  assert.match(status, /UNQUALIFIED/i);
});
