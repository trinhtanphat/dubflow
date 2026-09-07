import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deploymentPlan } from '../scripts/cloudflare-deploy.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workersBuildConfigGenerator = fs.readFileSync(new URL('../scripts/cloudflare-workers-build-config.mjs', import.meta.url), 'utf8');

test('deployment verifies, provisions, migrates, deploys and checks readiness in order', () => {
  assert.deepEqual(deploymentPlan(), [
    ['npm', ['run', 'verify']],
    ['npx', ['wrangler', 'deploy', '--dry-run']],
    ['npx', ['wrangler', 'deploy']],
    ['npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']],
    ['node', ['scripts/verify-deployment.mjs']],
  ]);
});

test('Workers Builds production deploy reconciles deployed D1 migration history before applying migrations', async () => {
  const scriptUrl = new URL('../scripts/cloudflare-workers-build-deploy.mjs', import.meta.url);
  assert.equal(
    fs.existsSync(scriptUrl),
    true,
    'Workers Builds must use a repository-owned deploy script that also applies D1 migrations',
  );

  const { workersBuildDeploymentPlan } = await import(scriptUrl.href);
  assert.deepEqual(workersBuildDeploymentPlan(), [
    ['npx', ['wrangler', 'deploy', '--config', '.wrangler-production.json']],
    ['node', ['scripts/reconcile-d1-migration-history.mjs']],
    ['npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', '.wrangler-production.json']],
    ['node', ['scripts/verify-deployment.mjs']],
  ]);
});

test('legacy visual-lipsync migration rename is reconciled only when deployed schema proves it was applied', () => {
  const reconcileUrl = new URL('../scripts/reconcile-d1-migration-history.mjs', import.meta.url);
  assert.equal(
    fs.existsSync(reconcileUrl),
    true,
    'deployment must reconcile the previously deployed 0012_visual_lipsync.sql migration name before current migrations run',
  );
  const source = fs.readFileSync(reconcileUrl, 'utf8');
  assert.match(source, /0012_visual_lipsync\.sql/);
  assert.match(source, /0013_visual_lipsync\.sql/);
  assert.match(source, /d1_migrations/);
  assert.match(source, /lip_sync_status/);
  assert.match(source, /provider_media_grants/);
});

test('Workers Builds production config keeps Stream and contains no FFmpeg Container runtime', () => {
  const wrangler = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const deployScript = fs.readFileSync(new URL('../scripts/cloudflare-workers-build-deploy.mjs', import.meta.url), 'utf8');
  assert.deepEqual(wrangler.stream, { binding: 'STREAM' });
  assert.equal(wrangler.containers, undefined);
  assert.equal(wrangler.durable_objects, undefined);
  assert.equal(wrangler.exports?.FfmpegContainer, undefined);
  assert.doesNotMatch(deployScript, /FFMPEG_CONTAINER|FfmpegContainer|containers\/ffmpeg/);
});

test('Workers Builds generator strips dormant paid runtime and custom-domain fields defense-in-depth', () => {
  assert.match(workersBuildConfigGenerator, /delete\s+source\.containers\b/);
  assert.match(workersBuildConfigGenerator, /delete\s+source\.durable_objects\b/);
  assert.match(workersBuildConfigGenerator, /delete\s+source\.exports\b/);
  assert.match(workersBuildConfigGenerator, /delete\s+source\.routes\b/);
});

test('Workers Builds build phase is remote-mutation free and leaves migrations to the deployment phase', () => {
  assert.doesNotMatch(pkg.scripts.build, /cloudflare-workers-build-migrate/i);
  assert.doesNotMatch(pkg.scripts.build, /wrangler\s+d1\s+migrations\s+apply/i);
  assert.equal(pkg.scripts.build, 'tsc -b && vite build');
});
