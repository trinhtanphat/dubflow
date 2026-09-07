import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const status = fs.readFileSync(new URL('../docs/deployment-status.md', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../docs/DEPLOYMENT-POLICY.md', import.meta.url), 'utf8');

test('deployment status documents the split public gateway and backend state ownership', () => {
  assert.match(status, /yupvox\.qs3d\.site/);
  assert.match(status, /50afb4fd3c4c7a1f3e1bdb7f22d4af7f/);
  assert.match(status, /6c5207813df3d5b83b9508125e0e9e12/);
  assert.match(status, /gateway/i);
  assert.match(status, /persisted projects|production data|D1\/R2/i);
  assert.match(status, /Containers.*disabled|disabled.*Containers/is);
  assert.match(policy, /Cloudflare Workers Builds/i);
  assert.match(policy, /GitHub Actions is CI only/i);
  assert.match(policy, /must not deploy production/i);
  assert.match(policy, /main/);
});
