import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const exportWorkflowSource = await readFile(
  new URL('../worker/src/workflows/ExportWorkflow.ts', import.meta.url),
  'utf8',
);
const exportRouteSource = await readFile(
  new URL('../worker/src/routes/export.ts', import.meta.url),
  'utf8',
);
const productionFixtureWorkflow = await readFile(
  new URL('../.github/workflows/production-media-fixture.yml', import.meta.url),
  'utf8',
);

test('production export admission and workflow share the voice provider selector', () => {
  assert.match(exportWorkflowSource, /createVoiceProvider/);
  assert.match(exportRouteSource, /createVoiceProvider/);
  assert.doesNotMatch(exportWorkflowSource, /new\s+ElevenLabsVoiceProvider/);
  assert.doesNotMatch(exportRouteSource, /new\s+ElevenLabsVoiceProvider/);
});

test('production media fixture reruns when the TTS fallback boundary changes', () => {
  assert.match(productionFixtureWorkflow, /worker\/src\/services\/voice\/\*\*/);
  assert.match(productionFixtureWorkflow, /worker\/src\/routes\/export\.ts/);
  assert.match(productionFixtureWorkflow, /worker\/src\/workflows\/ExportWorkflow\.ts/);
  assert.match(productionFixtureWorkflow, /worker\/src\/workflows\/zeroContainerExportPipeline\.ts/);
  assert.doesNotMatch(productionFixtureWorkflow, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
});
