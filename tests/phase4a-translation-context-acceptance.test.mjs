import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const [
  migration,
  contextSource,
  contextStoreSource,
  routerSource,
  contextualSource,
  workersAiSource,
  googleSource,
  contextRoutesSource,
  pipelineSource,
  settingsApiSource,
  settingsPanelSource,
  packageSource,
  deploymentStatus,
] = await Promise.all([
  source('migrations/0006_translation_context.sql'),
  source('worker/src/services/translation/context.ts'),
  source('worker/src/db/translation-context.ts'),
  source('worker/src/services/translation/router.ts'),
  source('worker/src/services/translation/contextual.ts'),
  source('worker/src/services/translation/workers-ai.ts'),
  source('worker/src/services/translation/google.ts'),
  source('worker/src/routes/translation-context.ts'),
  source('worker/src/workflows/pipeline.ts'),
  source('src/features/translation/translationSettingsApi.ts'),
  source('src/features/translation/TranslationSettingsPanel.tsx'),
  source('package.json'),
  source('docs/deployment-status.md'),
]);

test('Phase 4A keeps canonical translation-context storage and provider boundaries', () => {
  assert.match(migration, /translation_style/);
  assert.match(migration, /translation_context_revision/);
  assert.match(migration, /project_glossary_entries/);
  assert.match(contextSource, /128 \* 1024/);
  assert.match(routerSource, /TRANSLATION_CONTEXT_UNSUPPORTED/);
  assert.match(contextualSource, /CONTEXT_TRANSLATION_ID_MISMATCH/);
  assert.match(workersAiSource, /contextual:\s*false/);
  assert.match(googleSource, /contextual:\s*false/);
});

test('Phase 4A keeps revision-safe ownership, pipeline provenance and Phase 3B accounting semantics', () => {
  assert.match(contextStoreSource, /TRANSLATION_CONTEXT_CONFLICT/);
  assert.match(contextRoutesSource, /PROJECT_NOT_FOUND/);
  assert.match(contextRoutesSource, /expectedContextRevision/);
  assert.match(pipelineSource, /translation_character/);
  assert.match(pipelineSource, /routed\.contextRevision/);
  assert.doesNotMatch(pipelineSource, /credit_balance\s*[-+]=/);
});

test('Phase 4A Studio exposes server-backed glossary and style controls without Phase 3C implementation leakage', () => {
  assert.match(settingsApiSource, /translation-settings/);
  assert.match(settingsApiSource, /glossary/);
  assert.match(settingsPanelSource, /translation-settings-panel/);
  assert.match(settingsPanelSource, /200/);

  const phase4aProductionSources = [
    migration,
    contextSource,
    contextStoreSource,
    contextualSource,
    contextRoutesSource,
    settingsApiSource,
    settingsPanelSource,
  ];
  for (const phase4aSource of phase4aProductionSources) {
    assert.doesNotMatch(phase4aSource, /share[_-]?token|rate[_-]?limit/i);
  }
});

test('Phase 4A acceptance is wired into source verification and documented as source-qualified only', () => {
  assert.match(packageSource, /tests\/phase4a-translation-context-acceptance\.test\.mjs/);
  assert.match(deploymentStatus, /Phase 4A translation context qualification/);
  assert.match(deploymentStatus, /source-qualified only/i);
  assert.match(deploymentStatus, /contextual model runtime[^\n]*not proven/i);
  assert.match(deploymentStatus, /runtime status remains \*\*UNQUALIFIED\*\*/);
});
