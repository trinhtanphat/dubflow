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
const exportPipeline = read('worker/src/workflows/exportPipeline.ts');
const syncLabs = read('worker/src/services/lipsync/sync-labs.ts');
const providerMedia = read('worker/src/routes/provider-media.ts');
const providerGrants = read('worker/src/db/provider-media-grants.ts');
const providerToken = read('worker/src/security/provider-media-token.ts');
const readiness = read('worker/src/routes/readiness.ts');
const verifyDeployment = read('scripts/verify-deployment.mjs');
const studio = read('src/features/export/BatchExportPanel.tsx');
const api = read('src/features/export/batchExportApi.ts');
const productionConfigGenerator = read('scripts/cloudflare-workers-build-config.mjs');
const deploymentStatus = read('docs/deployment-status.md');
const ci = read('.github/workflows/ci.yml');
const viteConfig = read('vite.config.ts');
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

test('Phase 4E provider boundary and admission stay explicit and fail closed', () => {
  assert.match(syncLabs, /class\s+SyncLabsLipSyncProvider/);
  assert.match(exportRoute, /SYNC_API_KEY/);
  assert.match(exportRoute, /SYNC_LIPSYNC_QUALIFIED/);
  assert.match(exportRoute, /LIP_SYNC_UNAVAILABLE/);
  assert.match(exportRoute, /visualLipSync/);
  assert.match(exportRoute, /syncLabsLipSyncCapability/);
  assert.doesNotMatch(exportRoute, /function\s+visualLipSyncCapability/);
  assert.match(exportRoute, /visualMode\s*===\s*['"]lip_sync['"]\s*&&\s*!visualLipSyncAvailable/);
  assert.match(exportWorkflow, /qualifiedSyncLabsApiKey/);
  assert.match(exportWorkflow, /SYNC_LIPSYNC_QUALIFIED/);
});

test('Phase 4E provider media access is token-hashed, bounded and never canonical provider state', () => {
  assert.match(providerToken, /SHA-256|SHA-?256|digest\(['"]SHA-256['"]/i);
  assert.match(providerMedia, /resolveActive/);
  assert.match(providerMedia, /markAccessed/);
  assert.match(providerGrants, /expires_at/);
  assert.match(providerGrants, /consumed_at/);
  assert.match(providerGrants, /expires_at\s*>\s*\?/);
  assert.match(workflow, /15\s*\*\s*60\s*\*\s*1000/);
  assert.match(workflow, /providerMediaGrants\.expire/);
  assert.match(workflow, /fetchImpl\(result\.outputUrl/);
  assert.doesNotMatch(migration, /provider_output_url/i);
});

test('Phase 4E keeps standard output canonical first and publishes visual output under a separate exact R2 key', () => {
  const publishStandardIndex = exportPipeline.indexOf("step.do('publish standard export'");
  const visualCallIndex = exportPipeline.indexOf('await runVisualLipSync(');
  assert.ok(publishStandardIndex >= 0);
  assert.ok(visualCallIndex > publishStandardIndex);
  assert.match(workflow, /\.lipsync\.mp4/);
  assert.match(workflow, /projects\/\$\{context\.projectId\}\/exports\/\$\{context\.targetLanguage\}\/\$\{context\.exportId\}\.lipsync\.mp4/);
  assert.match(exportPipeline, /standardPublished\s*&&\s*effective\.visualMode\s*===\s*['"]lip_sync['"]/);
});

test('Phase 4E owner download is a separate fail-closed route mounted before standard export media', () => {
  assert.match(visualRoute, /LIP_SYNC_NOT_READY/);
  assert.match(visualRoute, /lipSyncStatus\s*!==\s*['"]completed['"]/);
  assert.match(visualRoute, /lipSyncObjectKey\s*!==\s*expectedObjectKey/);
  assert.ok(app.indexOf('createVisualExportMediaRoutes()') < app.indexOf("app.route('/api/projects', exportRoutes)"));
  assert.match(api, /visualExportMediaUrl/);
  assert.match(api, /visualMode=lip_sync/);
  assert.match(studio, /Tải video lip-sync/);
  assert.match(studio, /Tải video dubbed chuẩn/);
});

test('Phase 4E usage and durable status expose visual work without upgrading incomplete attempts', () => {
  assert.match(workflow, /lip_sync_video_second/);
  assert.match(workflow, /retry:\$\{context\.retryCount\}:lipsync/);
  assert.match(studio, /Lip-sync đã xếp hàng/);
  assert.match(studio, /Đang xử lý lip-sync/);
  assert.match(studio, /Lip-sync thất bại/);
  assert.match(studio, /Lip-sync hoàn tất/);
});

test('Phase 4E visual schema remains required while current readiness advances to schema 13', () => {
  assert.match(readiness, /CURRENT_SCHEMA_REVISION\s*=\s*13\s+as const/);
  assert.match(readiness, /project_exports_lip_sync_status_column/);
  assert.match(readiness, /provider_media_grants_table/);
  assert.match(verifyDeployment, /CURRENT_SCHEMA_REVISION\s*=\s*13/);
});

test('Phase 4E remains source-qualified until a real deployed Sync/provider/media fixture passes', () => {
  assert.match(deploymentStatus, /Phase 4E optional visual lip-sync qualification/i);
  assert.match(deploymentStatus, /source\/CI qualification only/i);
  assert.match(deploymentStatus, /schema revision \*\*12\*\*/i);
  assert.match(deploymentStatus, /runtime remains \*\*UNQUALIFIED\*\*/i);
  assert.match(deploymentStatus, /real.*Sync.*fixture/i);
  assert.match(deploymentStatus, /SYNC_API_KEY/);
  assert.match(deploymentStatus, /SYNC_LIPSYNC_QUALIFIED/);
});

test('Phase 4E keeps GitHub Actions CI-only and the repository acceptance gate wired', () => {
  const wranglerDeployLines = ci.split('\n').filter((line) => /wrangler\s+deploy/i.test(line));
  assert.ok(wranglerDeployLines.length > 0, 'CI must retain Wrangler dry-run validation.');
  for (const line of wranglerDeployLines) assert.match(line, /--dry-run/i);
  assert.match(productionConfigGenerator, /delete\s+source\.containers/);
  assert.match(productionConfigGenerator, /delete\s+source\.durable_objects/);
  assert.match(productionConfigGenerator, /delete\s+source\.exports/);
  assert.match(pkg.scripts['verify:deploy-config'], /phase4e-lipsync-acceptance\.test\.mjs/);
});

test('build manifest retains every Vite React plugin imported by the build config', () => {
  assert.match(viteConfig, /from\s+['"]@vitejs\/plugin-react['"]/);
  assert.equal(typeof pkg.devDependencies?.['@vitejs/plugin-react'], 'string');
  assert.ok(pkg.devDependencies['@vitejs/plugin-react'].trim().length > 0);
});
