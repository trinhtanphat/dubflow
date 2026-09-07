import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const client = source('src/features/export/separationApi.ts');
const studio = source('src/app/StudioShell.tsx');
const panel = source('src/features/export/BatchExportPanel.tsx');
const route = source('worker/src/routes/separation.ts');
const app = source('worker/src/app.ts');
const index = source('worker/src/index.ts');
const separatorContainerSource = source('worker/src/containers/SeparatorContainer.ts');
const env = source('worker/src/env.ts');
const limiter = source('worker/src/security/rate-limit.ts');
const providerConfig = source('worker/src/services/separation/config.ts');
const provider = source('worker/src/services/separation/container.ts');
const workflow = source('worker/src/workflows/SeparationWorkflow.ts');
const pipeline = source('worker/src/workflows/separationPipeline.ts');
const exportPipeline = source('worker/src/workflows/exportPipeline.ts');
const wranglerText = source('wrangler.jsonc');
const wrangler = JSON.parse(wranglerText);
const productionConfigGenerator = source('scripts/cloudflare-workers-build-config.mjs');
const deploymentStatus = source('docs/deployment-status.md');

test('Phase 4D exposes explicit separation status and prepare APIs without implicit Studio work', () => {
  assert.match(client, /export\s+function\s+getSeparationStatus/);
  assert.match(client, /export\s+function\s+prepareSeparation/);
  assert.match(client, /retry:\s*true/);
  assert.match(route, /routes\.get\('\/:id\/separation'/);
  assert.match(route, /routes\.post\('\/:id\/separation'/);
  assert.match(route, /DIALOGUE_SEPARATION_UNQUALIFIED/);
  assert.match(route, /enforceRateLimit\(c,\s*'separation'/);
  assert.match(app, /createSeparationRoutes/);
  assert.match(studio, /getSeparationStatus\(projectId\)/);
  assert.match(studio, /prepareSeparation\(projectId/);
  const effects = [...studio.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\[[^\]]*\]\);/g)].map((match) => match[1]);
  assert.equal(effects.some((body) => /prepareSeparation\(/.test(body)), false, 'opening Studio must never auto-start separation');
});

test('Phase 4D Studio keeps all three canonical audio modes and explicit lifecycle truth', () => {
  assert.match(panel, /Dubbed voice only/);
  assert.match(panel, /Keep original ambience \(duck dialogue\)/);
  assert.match(panel, /Separated background stem/);
  for (const label of ['Prepare background', 'Not prepared', 'Processing', 'Ready', 'Failed', 'Stale', 'Unqualified']) {
    assert.match(panel, new RegExp(label, 'i'));
  }
  assert.match(panel, /separated_background/);
});

test('Phase 4D separated-background export reuses prepared durable stems and never starts the expensive provider', () => {
  assert.doesNotMatch(exportPipeline, /\.separate\(\{/);
  assert.match(exportPipeline, /latestCompleted/);
  assert.match(exportPipeline, /separated_background/);
  assert.match(exportPipeline, /DIALOGUE_SEPARATION_(?:UNAVAILABLE|ARTIFACT_INVALID)/);
});

test('Phase 4D keeps the optional Demucs source adapter but does not bind, export, or deploy paid Containers', () => {
  assert.match(providerConfig, /demucs/i);
  assert.match(providerConfig, /htdemucs/);
  assert.match(providerConfig, /8726e21a/);
  assert.match(providerConfig, /SEPARATION_RUNTIME_QUALIFIED/);
  assert.match(provider, /class\s+ContainerDialogueSeparationProvider/);
  assert.match(separatorContainerSource, /class\s+SeparatorContainer\s+extends\s+Container/);
  assert.match(workflow, /class\s+SeparationWorkflow/);
  assert.match(pipeline, /runSeparationPipeline/);
  assert.doesNotMatch(index, /export\s+\{\s*SeparatorContainer\s*\}/);
  assert.match(index, /SeparationWorkflow/);
  assert.match(env, /RATE_LIMIT_SEPARATION/);
  assert.match(env, /SEPARATOR_CONTAINER\?/);
  assert.match(env, /SEPARATION_WORKFLOW/);
  assert.match(limiter, /'separation'/);
  assert.match(wranglerText, /RATE_LIMIT_SEPARATION/);
  assert.match(wranglerText, /"limit":\s*2/);
  assert.match(wranglerText, /SEPARATION_WORKFLOW/);
  assert.equal(wrangler.containers, undefined);
  assert.equal(wrangler.durable_objects, undefined);
  assert.equal(wrangler.exports, undefined);
});

test('Phase 4D production remains fail-closed with Containers disabled', () => {
  assert.match(productionConfigGenerator, /delete\s+source\.containers\b/);
  assert.match(productionConfigGenerator, /delete\s+source\.durable_objects\b/);
  assert.match(productionConfigGenerator, /delete\s+source\.exports\b/);
  assert.match(deploymentStatus, /Phase 4D/i);
  assert.match(deploymentStatus, /UNQUALIFIED/i);
  assert.match(deploymentStatus, /Containers.*disabled|disabled.*Containers/is);
});
