import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const scriptUrl = new URL('../scripts/verify-production-media-fixture.mjs', import.meta.url);
const workflowUrl = new URL('../.github/workflows/production-media-fixture.yml', import.meta.url);
const exportWorkflowUrl = new URL('../worker/src/workflows/ExportWorkflow.ts', import.meta.url);
const exportRouteUrl = new URL('../worker/src/routes/export.ts', import.meta.url);

test('production media fixture runner is checked in and remains verification-only', () => {
  assert.equal(fs.existsSync(scriptUrl), true, 'missing production media fixture runner');
  assert.equal(fs.existsSync(workflowUrl), true, 'missing production media fixture workflow');

  const script = fs.readFileSync(scriptUrl, 'utf8');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(script, /yupvox\.qs3d\.site/);
  assert.match(script, /\/api\/projects/);
  assert.match(script, /\/process/);
  assert.match(script, /\/export/);
  assert.match(script, /video\/mp4/);
  assert.match(workflow, /verify-production-media-fixture\.mjs/);
  assert.match(workflow, /worker\/src\/services\/asr\/workers-ai\.ts/);
  assert.doesNotMatch(`${script}\n${workflow}`, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
});

test('production export admission and workflow share the voice provider selector', () => {
  const exportWorkflow = fs.readFileSync(exportWorkflowUrl, 'utf8');
  const exportRoute = fs.readFileSync(exportRouteUrl, 'utf8');
  assert.match(exportWorkflow, /createVoiceProvider/);
  assert.match(exportRoute, /createVoiceProvider/);
  assert.doesNotMatch(exportWorkflow, /new\s+ElevenLabsVoiceProvider/);
  assert.doesNotMatch(exportRoute, /new\s+ElevenLabsVoiceProvider/);
});

test('production media fixture reruns when the TTS fallback boundary changes', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /worker\/src\/services\/voice\/\*\*/);
  assert.match(workflow, /worker\/src\/routes\/export\.ts/);
  assert.match(workflow, /worker\/src\/workflows\/ExportWorkflow\.ts/);
  assert.match(workflow, /worker\/src\/workflows\/zeroContainerExportPipeline\.ts/);
  assert.doesNotMatch(workflow, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
});
