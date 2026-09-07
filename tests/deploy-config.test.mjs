import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const deploymentPolicy = fs.readFileSync(new URL('../docs/DEPLOYMENT-POLICY.md', import.meta.url), 'utf8');
const deploymentStatus = fs.readFileSync(new URL('../docs/deployment-status.md', import.meta.url), 'utf8');

const productionAccountId = '6c5207813df3d5b83b9508125e0e9e12';

function documentedProductionAccount(text, label) {
  const match = text.match(/(?:Cloudflare production account|production account|Cloudflare account)\s*:?\s*`([a-f0-9]{32})`/i);
  assert.ok(match, `${label} must declare the canonical Cloudflare production account`);
  return match[1];
}

test('deployment config contains no fake resource placeholder', () => {
  const d1 = config.d1_databases?.find((item) => item.binding === 'DB');
  assert.ok(d1);
  assert.notEqual(d1.database_id, 'REPLACE_WITH_D1_DATABASE_ID');
});

test('deployment uses Wrangler with automatic resource provisioning support', () => {
  const wrangler = pkg.devDependencies?.wrangler ?? '';
  const match = wrangler.match(/(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `invalid Wrangler version: ${wrangler}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  assert.ok(major > 4 || (major === 4 && minor >= 45), `Wrangler ${wrangler} is older than 4.45.0`);
});

test('production custom domain stays pinned to yupvox.qs3d.site', () => {
  assert.deepEqual(config.routes, [{ pattern: 'yupvox.qs3d.site', custom_domain: true }]);
});

test('production deploy targets the Cloudflare account that owns the live yupvox domain and persisted projects', () => {
  assert.equal(config.account_id, productionAccountId);
});

test('checked-in Wrangler account must match the documented canonical production topology', () => {
  const policyAccount = documentedProductionAccount(deploymentPolicy, 'DEPLOYMENT-POLICY.md');
  const statusAccount = documentedProductionAccount(deploymentStatus, 'deployment-status.md');
  assert.equal(policyAccount, statusAccount, 'deployment policy and status disagree on the canonical production account');
  assert.equal(config.account_id, policyAccount, 'wrangler account drifted away from the documented domain/data-owning production account');
});

test('live dubbing runtime is declared on the production account', () => {
  assert.equal(config.account_id, productionAccountId);
  assert.ok(config.containers?.some((entry) => entry.class_name === 'FfmpegContainer'));
  assert.ok(config.durable_objects?.bindings?.some((entry) => entry.name === 'FFMPEG_CONTAINER' && entry.class_name === 'FfmpegContainer'));
  assert.ok(config.workflows?.some((entry) => entry.binding === 'DUBBING_WORKFLOW' && entry.class_name === 'DubbingWorkflow'));
});
