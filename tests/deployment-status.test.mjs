import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const status = fs.readFileSync(new URL('../docs/deployment-status.md', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../docs/DEPLOYMENT-POLICY.md', import.meta.url), 'utf8');

test('deployment status pins production hostname and Workers Builds contract', () => {
  assert.match(status, /yupvox\.qs3d\.site/);
  assert.match(status, /6c5207813df3d5b83b9508125e0e9e12/);
  assert.match(policy, /Cloudflare Workers Builds/i);
  assert.match(policy, /GitHub Actions is CI only/i);
  assert.match(policy, /must not deploy production/i);
  assert.match(policy, /main/);
});
