import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const status = fs.readFileSync(new URL('../docs/deployment-status.md', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../docs/DEPLOYMENT-POLICY.md', import.meta.url), 'utf8');

test('deployment status pins the public hostname to its state-owning Cloudflare account and Workers Builds contract', () => {
  assert.match(status, /yupvox\.qs3d\.site/);
  assert.match(status, /50afb4fd3c4c7a1f3e1bdb7f22d4af7f/);
  assert.match(status, /custom domain/i);
  assert.match(status, /persisted projects|production data/i);
  assert.match(policy, /Cloudflare Workers Builds/i);
  assert.match(policy, /GitHub Actions is CI only/i);
  assert.match(policy, /must not deploy production/i);
  assert.match(policy, /main/);
});
