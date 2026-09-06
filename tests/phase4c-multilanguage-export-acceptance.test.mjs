import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const migration = read('migrations/0009_multilanguage_variants.sql');
const router = read('worker/src/services/translation/router.ts');
const languagePipeline = read('worker/src/workflows/languageTranslationPipeline.ts');
const exportPipeline = read('worker/src/workflows/exportPipeline.ts');
const exportRoute = read('worker/src/routes/export.ts');
const studio = read('src/app/StudioShell.tsx');
const packageJson = read('package.json');
const deploymentStatus = read('docs/deployment-status.md');
const deploymentPolicy = read('docs/DEPLOYMENT-POLICY.md');

test('Phase 4C source keeps canonical segments and exact target-language variants', () => {
  assert.match(migration, /CREATE TABLE(?: IF NOT EXISTS)? segment_translations/);
  assert.match(migration, /target_language/);
  assert.match(router, /TargetLanguage/);
  assert.match(languagePipeline, /targetLanguage/);
  assert.match(languagePipeline, /segment\.sourceText/);
  assert.match(languagePipeline, /project\.sourceLanguage,[\s\S]*params\.targetLanguage/);
  assert.doesNotMatch(languagePipeline, /translateBatch\([^)]*translatedText/);
});

test('Phase 4C export isolates language artifacts, usage identity, and fail-closed voice admission', () => {
  assert.match(exportPipeline, /projects\/\$\{projectId\}\/voices\/\$\{targetLanguage\}/);
  assert.match(exportPipeline, /projects\/\$\{params\.projectId\}\/subtitles\/\$\{params\.targetLanguage\}/);
  assert.match(exportPipeline, /\$\{params\.targetLanguage\}:\$\{segment\.id\}/);
  assert.match(exportRoute, /VOICE_LANGUAGE_UNQUALIFIED/);
  assert.match(exportRoute, /capabilities\.languages === 'unknown'/);
  assert.match(exportRoute, /enforceRateLimit\(c, 'export'/);
  assert.match(languagePipeline, /withProviderTelemetry/);
});

test('Phase 4C retains Vietnamese compatibility and Studio multi-language controls', () => {
  assert.match(exportRoute, /startLegacy/);
  assert.match(exportRoute, /targetLanguage: 'vi'/);
  assert.match(exportRoute, /output: 'dubbed'/);
  assert.match(exportPipeline, /legacyAudioObjectKey/);
  assert.match(studio, /TargetLanguagesPanel/);
  assert.match(studio, /BatchExportPanel/);
});

test('Phase 4C verification keeps prior safety acceptance lanes wired', () => {
  for (const acceptance of [
    'tests/phase3c-safety-acceptance.test.mjs',
    'tests/phase4a-translation-context-acceptance.test.mjs',
    'tests/phase4a-speaker-stitching-acceptance.test.mjs',
    'tests/phase4a-diarization-acceptance.test.mjs',
    'tests/phase4b-voice-clone-acceptance.test.mjs',
    'tests/phase4c-multilanguage-acceptance.test.mjs',
    'tests/phase4c-multilanguage-export-acceptance.test.mjs',
  ]) {
    assert.match(packageJson, new RegExp(acceptance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Phase 4C remains source-qualified while production follows the single Workers Builds lane', () => {
  assert.match(deploymentStatus, /## Phase 4C .*multi-language.*export qualification/i);
  for (const target of ['vi', 'en', 'zh', 'ja', 'ko']) assert.match(deploymentStatus, new RegExp(`\\b${target}\\b`));
  assert.match(deploymentStatus, /Vietnamese[\s\S]*(?:compatibility|backward compatibility)/i);
  assert.match(deploymentStatus, /Production runtime remains \*\*UNQUALIFIED\*\*/i);
  assert.match(deploymentPolicy, /Cloudflare Workers Builds is the only production deployment lane/i);
  assert.match(deploymentStatus, /real .*provider.*media.*fixture/is);
  assert.doesNotMatch(deploymentStatus, /Phase 4C production runtime[^\n]*(?:PASS|qualified)/i);
});
