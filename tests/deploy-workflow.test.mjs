import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');

test('Cloudflare deployment runs on main pushes and remains manually dispatchable', () => {
  assert.match(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^      - main\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
});
