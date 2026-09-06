import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const migration = source('migrations/0011_phase4d_audio_separation.sql');
const audioMode = source('worker/src/domain/audio-mode.ts');
const render = source('containers/ffmpeg/render-export.mjs');
const separationTypes = source('worker/src/services/separation/types.ts');
const unavailable = source('worker/src/services/separation/unavailable.ts');
const exportRoute = source('worker/src/routes/export.ts');
const exportWorkflow = source('worker/src/workflows/ExportWorkflow.ts');
const studio = source('src/features/export/BatchExportPanel.tsx');
const readiness = source('worker/src/routes/readiness.ts');
const ci = source('.github/workflows/ci.yml');
const readme = source('README.md');
const deploymentStatus = source('docs/deployment-status.md');

test('Phase 4D persists the canonical source generation, audio mode, and reusable stem schema', () => {
  assert.match(migration, /source_generation/i);
  assert.match(migration, /audio_mode/i);
  assert.match(migration, /CREATE TABLE project_audio_stems/i);
  assert.match(migration, /idx_project_audio_stems_active/i);
  assert.match(readiness, /CURRENT_SCHEMA_REVISION = 12 as const/);
  assert.match(readiness, /project_audio_stems/);
});

test('Phase 4D exposes exactly three backwards-compatible dubbed audio modes', () => {
  assert.match(audioMode, /'dubbed_only'\s*\|\s*'duck_original'\s*\|\s*'separated_background'/);
  assert.match(audioMode, /value === undefined\) return 'dubbed_only'/);
});

test('Phase 4D locks deterministic ducking and separated-background rendering constants', () => {
  assert.match(render, /DUCK_GAIN_DB\s*=\s*-18/);
  assert.match(render, /DUCK_ATTACK_MS\s*=\s*80/);
  assert.match(render, /DUCK_RELEASE_MS\s*=\s*120/);
  assert.match(render, /duck_original/);
  assert.match(render, /separated_background/);
});

test('Phase 4D separation stays fail-closed with stable errors and an unavailable production adapter', () => {
  for (const code of [
    'DIALOGUE_SEPARATION_UNAVAILABLE',
    'DIALOGUE_SEPARATION_UNQUALIFIED',
    'DIALOGUE_SEPARATION_FAILED',
    'DIALOGUE_SEPARATION_ARTIFACT_INVALID',
  ]) assert.match(separationTypes, new RegExp(code));
  assert.match(unavailable, /qualification:\s*'unavailable'/);
  assert.match(unavailable, /configured:\s*false/);
  assert.match(exportWorkflow, /new UnavailableDialogueSeparationProvider\(\)/);
});

test('Phase 4D exposes capability admission and honest Studio treatment labels', () => {
  assert.match(exportRoute, /export-capabilities/);
  assert.match(studio, /Dubbed voice only/);
  assert.match(studio, /Keep original ambience \(duck dialogue\)/);
  assert.match(studio, /Separated background stem/);
  assert.match(studio, /qualification !== 'qualified'/);
});

test('Phase 4D keeps GitHub Actions CI-only and documents source qualification truthfully', () => {
  assert.doesNotMatch(ci, /wrangler\s+deploy\s+--env\s+production/i);
  assert.doesNotMatch(ci, /cloudflare-workers-build-deploy/i);
  assert.match(readme, /duck_original/);
  assert.match(readme, /separated_background/);
  assert.match(readme, /UNQUALIFIED/i);
  assert.match(deploymentStatus, /Phase 4D/i);
  assert.match(deploymentStatus, /Workers Builds/i);
  assert.match(deploymentStatus, /UNQUALIFIED/i);
});
