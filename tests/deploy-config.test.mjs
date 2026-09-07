import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const gatewayConfigUrl = new URL('../wrangler.gateway.jsonc', import.meta.url);
const gatewaySourceUrl = new URL('../gateway/src/index.ts', import.meta.url);
const architectureUrl = new URL('../docs/CLOUDFLARE-CROSS-ACCOUNT-WORKERS-ONLY.md', import.meta.url);

const backendAccountId = '6c5207813df3d5b83b9508125e0e9e12';
const zoneAccountId = '50afb4fd3c4c7a1f3e1bdb7f22d4af7f';

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

test('backend deploy targets trinhtanphat6666 without trying to own the qs3d.site custom domain', () => {
  assert.equal(config.account_id, backendAccountId);
  assert.equal(config.workers_dev, true);
  assert.ok(!config.routes || config.routes.length === 0, 'backend account must not attach the 2403-owned custom domain');
  assert.ok(config.workflows?.some((entry) => entry.binding === 'DUBBING_WORKFLOW' && entry.class_name === 'DubbingWorkflow'));
});

test('production backend does not declare paid Cloudflare Containers', () => {
  assert.equal(config.containers, undefined);
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.exports, undefined);
});

test('zone-owner gateway is the only config that attaches yupvox.qs3d.site', () => {
  assert.equal(fs.existsSync(gatewayConfigUrl), true, 'add the cross-account gateway Wrangler config');
  assert.equal(fs.existsSync(gatewaySourceUrl), true, 'add the cross-account gateway Worker');
  const gateway = JSON.parse(fs.readFileSync(gatewayConfigUrl, 'utf8'));
  assert.equal(gateway.account_id, zoneAccountId);
  assert.deepEqual(gateway.routes, [{ pattern: 'yupvox.qs3d.site', custom_domain: true }]);
  assert.equal(gateway.containers, undefined);
  assert.equal(gateway.durable_objects, undefined);
  assert.equal(gateway.d1_databases, undefined);
  assert.equal(gateway.r2_buckets, undefined);
  assert.equal(gateway.workflows, undefined);
});

test('cross-account workers-only architecture is repository documented', () => {
  assert.equal(fs.existsSync(architectureUrl), true, 'add the architecture note requested for the production topology');
  const note = fs.readFileSync(architectureUrl, 'utf8');
  assert.match(note, /trinhtanphat2403/i);
  assert.match(note, /trinhtanphat6666/i);
  assert.match(note, /yupvox\.qs3d\.site/i);
  assert.match(note, /Containers.*disabled|disabled.*Containers/is);
  assert.match(note, /BACKEND_ORIGIN/);
});
