import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');

test('Cloudflare deployment is manual-only while container credentials are externally qualified', () => {
  assert.doesNotMatch(workflow, /^  push:\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
});
