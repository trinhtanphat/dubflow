import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deploymentPlan } from '../scripts/cloudflare-deploy.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const configGenerator = fs.readFileSync(new URL('../scripts/cloudflare-workers-build-config.mjs', import.meta.url), 'utf8');

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

test('Workers Builds production config strips FFmpeg container deployment while source keeps the optional binding', () => {
  const wrangler = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(wrangler.containers?.some((entry) => entry.class_name === 'FfmpegContainer'));
  assert.ok(wrangler.durable_objects?.bindings?.some((entry) => entry.name === 'FFMPEG_CONTAINER' && entry.class_name === 'FfmpegContainer'));
  assert.match(configGenerator, /delete\s+source\.containers\b/);
  assert.match(configGenerator, /delete\s+source\.durable_objects\b/);
  assert.match(configGenerator, /delete\s+source\.exports\b/);
});

test('Workers Builds hard-pins account 2403 before generating its zero-container production config', () => {
  assert.match(configGenerator, /PRODUCTION_ACCOUNT_ID\s*=\s*['"]50afb4fd3c4c7a1f3e1bdb7f22d4af7f['"]/);
  assert.match(configGenerator, /source\.account_id\s*=\s*PRODUCTION_ACCOUNT_ID/);
  assert.match(configGenerator, /delete\s+source\.containers\b/);
  assert.match(configGenerator, /delete\s+source\.durable_objects\b/);
  assert.match(configGenerator, /delete\s+source\.exports\b/);
});

test('Workers Builds generated production config contains no paid Container or Durable Object lifecycle state', async () => {
  const scriptUrl = new URL('../scripts/cloudflare-workers-build-config.mjs', import.meta.url);
  const { prepareWorkersBuildConfig, PRODUCTION_CONFIG_PATH } = await import(scriptUrl.href);
  const productionConfigUrl = new URL(`../${PRODUCTION_CONFIG_PATH}`, import.meta.url);

  try {
    prepareWorkersBuildConfig();
    const production = JSON.parse(fs.readFileSync(productionConfigUrl, 'utf8'));
    assert.equal(production.account_id, '50afb4fd3c4c7a1f3e1bdb7f22d4af7f');
    assert.equal(Object.hasOwn(production, 'containers'), false, 'production config must not deploy Containers');
    assert.equal(Object.hasOwn(production, 'durable_objects'), false, 'production config must not bind Container Durable Objects');
    assert.equal(Object.hasOwn(production, 'exports'), false, 'production config must not declare Durable Object lifecycle exports');
  } finally {
    fs.rmSync(productionConfigUrl, { force: true });
  }
});

test('Workers Builds build phase is remote-mutation free and leaves migrations to the deployment phase', () => {
  assert.doesNotMatch(pkg.scripts.build, /cloudflare-workers-build-migrate/i);
  assert.doesNotMatch(pkg.scripts.build, /wrangler\s+d1\s+migrations\s+apply/i);
  assert.equal(pkg.scripts.build, 'tsc -b && vite build');
});
