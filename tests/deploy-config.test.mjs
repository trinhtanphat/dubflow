import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const configText = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const config = JSON.parse(configText);
const gateway = JSON.parse(fs.readFileSync(new URL('../wrangler.gateway.jsonc', import.meta.url), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const backendAccountId = '6c5207813df3d5b83b9508125e0e9e12';
const gatewayAccountId = '50afb4fd3c4c7a1f3e1bdb7f22d4af7f';

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

test('public custom domain belongs only to the account-2403 gateway', () => {
  assert.equal(config.account_id, backendAccountId);
  assert.equal(config.workers_dev, true);
  assert.equal(config.routes, undefined);
  assert.equal(gateway.account_id, gatewayAccountId);
  assert.deepEqual(gateway.routes, [{ pattern: 'yupvox.qs3d.site', custom_domain: true }]);
  assert.equal(gateway.keep_vars, true, 'gateway deploys must preserve runtime BACKEND_ORIGIN configured outside source');
});

test('R2-only dubbing runtime stays on backend account 6666 without Stream or Containers', () => {
  assert.equal(config.account_id, backendAccountId);
  assert.equal(config.stream, undefined);
  assert.doesNotMatch(configText, /CLOUDFLARE_STREAM_API_TOKEN/);
  assert.equal(config.containers, undefined);
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.exports, undefined);
  assert.ok(config.r2_buckets?.some((entry) => entry.binding === 'MEDIA'));
  assert.ok(config.workflows?.some((entry) => entry.binding === 'DUBBING_WORKFLOW' && entry.class_name === 'DubbingWorkflow'));
  assert.equal(config.vars?.PUBLIC_ORIGIN, 'https://yupvox.qs3d.site');
});
