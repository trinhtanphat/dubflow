import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const migration = read('migrations/0012_visual_lipsync.sql');
const exportRoute = read('worker/src/routes/export.ts');
const visualRoute = read('worker/src/routes/visual-export-media.ts');
const app = read('worker/src/app.ts');
const workflow = read('worker/src/workflows/visualLipSync.ts');
const exportWorkflow = read('worker/src/workflows/ExportWorkflow.ts');
const zeroContainerExportPipeline = read('worker/src/workflows/zeroContainerExportPipeline.ts');
const syncLabs = read('worker/src/services/lipsync/sync-labs.ts');
const qualification = read('worker/src/services/lipsync/qualification.ts');
const providerMedia = read('worker/src/routes/provider-media.ts');
const providerGrants = read('worker/src/db/provider-media-grants.ts');
const providerToken = read('worker/src/security/provider-media-token.ts');
const readiness = read('worker/src/routes/readiness.ts');
const verifyDeployment = read('scripts/verify-deployment.mjs');
const studio = read('src/features/export/BatchExportPanel.tsx');
const api = read('src/features/export/batchExportApi.ts');
const wrangler = read('wrangler.jsonc');
const productionConfigGenerator = read('scripts/cloudflare-workers-build-config.mjs');
const deploymentStatus = read('docs/deployment-status.md');
const ci = read('.github/workflows/ci.yml');
const pkg = JSON.parse(read('package.json'));

test('Phase 4E migration persists visual state and short-lived provider grant authority', () => {
  assert.match(migration, /lip_sync_requested/i);
  assert.match(migration, /lip_sync_provider/i);
  assert.match(migration, /lip_sync_status/i);
  assert.match(migration, /lip_sync_object_key/i);
  assert.match(migration, /CREATE TABLE\s+provider_media_grants/i);
  assert.match(migration, /token_hash/i);
  assert.match(migration, /expires_at/i);
  assert.match(migration, /consumed_at/i);
});

test('Phase 4E provider admission shares one explicit runtime qualification source of truth', () => {
  assert.match(syncLabs, /class\s+SyncLabsLipSyncProvider/);
  assert.match(qualification, /syncLabsLipSyncCapability/);
  assert.match(qualification, /qualifiedSyncLabsApiKey/);
  assert.match(exportRoute, /SYNC_API_KEY/);
  assert.match(exportRoute, /SYNC_LIPSYNC_QUALIFIED/);
  assert.match(exportRoute, /syncLabsLipSyncCapability/);
  assert.match(exportRoute, /LIP_SYNC_UNAVAILABLE/);
  assert.doesNotMatch(exportRoute, /return\s+Boolean\(env\.SYNC_API_KEY\?\.trim\(\)\)/);
  assert.match(exportWorkflow, /qualifiedSyncLabsApiKey/);
  assert.match(exportWorkflow, /SYNC_LIPSYNC_QUALIFIED/);
});

test('Phase 4E provider media access stays token-hashed and bounded', () => {
  assert.match(providerToken, /SHA-256|digest\(['"]SHA-256['"]/i);
  assert.match(providerMedia, /resolveActive/);
  assert.match(providerMedia, /markAccessed/);
  assert.match(providerGrants, /expires_at/);
  assert.match(providerGrants, /consumed_at/);
  assert.match(workflow, /15\s*\*\s*60\s*\*\s*1000/);
  assert.match(workflow, /providerMediaGrants\.expire/);
});

test('Phase 4E keeps standard output canonical and visual output separate', () => {
  const publishStandardIndex = zeroContainerExportPipeline.indexOf("step.do('publish standard zero-container export'");
  const visualCallIndex = zeroContainerExportPipeline.indexOf('await runVisualLipSync(');
  assert.ok(publishStandardIndex >= 0);
  assert.ok(visualCallIndex > publishStandardIndex);
  assert.match(zeroContainerExportPipeline, /standardPublished\s*=\s*true/);
  assert.match(zeroContainerExportPipeline, /standardPublished\s*&&\s*effective\.visualMode\s*===\s*['"]lip_sync['"]/);
  assert.match(workflow, /\.lipsync\.mp4/);
});

test('Phase 4E owner download remains a separate fail-closed route', () => {
  assert.match(visualRoute, /LIP_SYNC_NOT_READY/);
  assert.match(visualRoute, /lipSyncStatus\s*!==\s*['"]completed['"]/);
  assert.ok(app.indexOf('createVisualExportMediaRoutes()') < app.indexOf("app.route('/api/projects', exportRoutes)"));
  assert.match(api, /visualExportMediaUrl/);
  assert.match(studio, /Tải video lip-sync/);
});

test('Phase 4E zero-container readiness is schema 13 and runtime stays unqualified by default', () => {
  assert.match(readiness, /CURRENT_SCHEMA_REVISION\s*=\s*13\s+as const/);
  assert.match(verifyDeployment, /CURRENT_SCHEMA_REVISION\s*=\s*13/);
  assert.match(deploymentStatus, /schema revision \*\*13\*\*/i);
  assert.match(deploymentStatus, /runtime remains \*\*UNQUALIFIED\*\*/i);
  assert.match(deploymentStatus, /SYNC_LIPSYNC_QUALIFIED/);
  assert.doesNotMatch(wrangler, /SYNC_LIPSYNC_QUALIFIED[\s\S]*true/i);
});

test('Phase 4E keeps GitHub CI-only and no Container runtime', () => {
  const deployLines = ci.split('\n').filter((line) => /wrangler\s+deploy/i.test(line));
  for (const line of deployLines) assert.match(line, /--dry-run/i);
  const config = JSON.parse(wrangler);
  assert.equal(config.containers, undefined);
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.exports, undefined);
  assert.match(productionConfigGenerator, /delete\s+source\.containers/);
  assert.match(productionConfigGenerator, /delete\s+source\.durable_objects/);
  assert.match(productionConfigGenerator, /delete\s+source\.exports/);
  assert.match(productionConfigGenerator, /delete\s+source\.routes/);
  assert.match(pkg.scripts['verify:deploy-config'], /phase4e-lipsync-acceptance\.test\.mjs/);
});
