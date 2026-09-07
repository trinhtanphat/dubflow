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

test('Workers Builds production config is R2-only and contains no Stream or FFmpeg Container runtime', () => {
  const wrangler = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const deployScript = fs.readFileSync(new URL('../scripts/cloudflare-workers-build-deploy.mjs', import.meta.url), 'utf8');
  assert.equal(wrangler.stream, undefined);
  assert.ok(wrangler.r2_buckets?.some((entry) => entry.binding === 'MEDIA'));
  assert.equal(wrangler.containers, undefined);
  assert.equal(wrangler.durable_objects, undefined);
  assert.equal(wrangler.exports?.FfmpegContainer, undefined);
  assert.doesNotMatch(deployScript, /FFMPEG_CONTAINER|FfmpegContainer|containers\/ffmpeg|CLOUDFLARE_STREAM_API_TOKEN/);
});

test('Workers Builds generator strips dormant paid runtime, Stream, and custom-domain fields defense-in-depth', () => {
  assert.match(workersBuildConfigGenerator, /delete\s+source\.containers\b/);
  assert.match(workersBuildConfigGenerator, /delete\s+source\.durable_objects\b/);
  assert.match(workersBuildConfigGenerator, /delete\s+source\.exports\b/);
  assert.match(workersBuildConfigGenerator, /delete\s+source\.stream\b/);
  assert.match(workersBuildConfigGenerator, /delete\s+source\.routes\b/);
});

test('Workers Builds build phase is remote-mutation free and leaves migrations to the deployment phase', () => {
  assert.doesNotMatch(pkg.scripts.build, /cloudflare-workers-build-migrate/i);
  assert.doesNotMatch(pkg.scripts.build, /wrangler\s+d1\s+migrations\s+apply/i);
  assert.equal(pkg.scripts.build, 'tsc -b && vite build');
});

test('gateway Workers Builds deploy preserves the checked-in custom domain and keep-vars contract', async () => {
  const scriptUrl = new URL('../scripts/cloudflare-gateway-workers-build-deploy.mjs', import.meta.url);
  assert.equal(
    fs.existsSync(scriptUrl),
    true,
    'gateway Workers Builds must use a repository-owned deploy script instead of inline config mutation',
  );

  const { gatewayWorkersBuildDeploymentPlan } = await import(scriptUrl.href);
  assert.deepEqual(gatewayWorkersBuildDeploymentPlan(), [
    ['npx', ['wrangler', 'deploy', '--config', 'wrangler.gateway.jsonc']],
  ]);

  const script = fs.readFileSync(scriptUrl, 'utf8');
  assert.doesNotMatch(script, /delete\s+.*routes|workers_dev\s*=\s*true/i);
});
