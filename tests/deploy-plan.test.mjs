import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deploymentPlan } from '../scripts/cloudflare-deploy.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('deployment verifies, provisions, migrates, deploys and checks readiness in order', () => {
  assert.deepEqual(deploymentPlan(), [
    ['npm', ['run', 'verify']],
    ['npx', ['wrangler', 'deploy', '--dry-run']],
    ['npx', ['wrangler', 'deploy']],
    ['npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']],
    ['node', ['scripts/verify-deployment.mjs']],
  ]);
});

test('Workers Builds production deploy applies remote D1 migrations before readiness verification', async () => {
  const scriptUrl = new URL('../scripts/cloudflare-workers-build-deploy.mjs', import.meta.url);
  assert.equal(
    fs.existsSync(scriptUrl),
    true,
    'Workers Builds must use a repository-owned deploy script that also applies D1 migrations',
  );

  const { workersBuildDeploymentPlan } = await import(scriptUrl.href);
  assert.deepEqual(workersBuildDeploymentPlan(), [
    ['npx', ['wrangler', 'deploy', '--config', '.wrangler-production.json']],
    ['npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', '.wrangler-production.json']],
    ['node', ['scripts/verify-deployment.mjs']],
  ]);
});

test('Workers Builds production config retains the FFmpeg container binding used by workflows', () => {
  const wrangler = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const deployScript = fs.readFileSync(new URL('../scripts/cloudflare-workers-build-deploy.mjs', import.meta.url), 'utf8');
  assert.ok(wrangler.containers?.some((entry) => entry.class_name === 'FfmpegContainer'));
  assert.ok(wrangler.durable_objects?.bindings?.some((entry) => entry.name === 'FFMPEG_CONTAINER' && entry.class_name === 'FfmpegContainer'));
  assert.doesNotMatch(deployScript, /delete\s+source\.containers\b/);
  assert.doesNotMatch(deployScript, /delete\s+source\.durable_objects\b/);
});

test('Workers Builds build phase is remote-mutation free and leaves migrations to the deployment phase', () => {
  assert.doesNotMatch(pkg.scripts.build, /cloudflare-workers-build-migrate/i);
  assert.doesNotMatch(pkg.scripts.build, /wrangler\s+d1\s+migrations\s+apply/i);
  assert.equal(pkg.scripts.build, 'tsc -b && vite build');
});
