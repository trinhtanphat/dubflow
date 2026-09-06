import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deploymentPlan } from '../scripts/cloudflare-deploy.mjs';

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
