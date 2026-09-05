import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const status = fs.readFileSync(new URL('../docs/deployment-status.md', import.meta.url), 'utf8');

test('deployment status pins production hostname and GitHub Actions contract', () => {
  assert.match(status, /yupvox\.qs3d\.site/);
  assert.match(status, /GitHub Actions is enabled/);
  assert.match(status, /CLOUDFLARE_API_TOKEN/);
  assert.match(status, /manual-only/i);
  assert.match(status, /Containers (?:Write|Edit)/);
});
