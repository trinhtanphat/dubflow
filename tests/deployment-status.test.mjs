import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const status = fs.readFileSync(new URL('../docs/deployment-status.md', import.meta.url), 'utf8');

test('deployment status pins the production hostname and forbids GitHub Actions', () => {
  assert.match(status, /yupvox\.qs3d\.site/);
  assert.match(status, /does not use GitHub Actions/);
});
