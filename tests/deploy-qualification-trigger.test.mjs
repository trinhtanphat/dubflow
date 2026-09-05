import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');

test('production qualification carrier can trigger deploy without enabling main auto-deploy', () => {
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^  push:\s*\n    branches:\s*\n      - ops\/production-qualification-20260905\s*$/m);
  assert.doesNotMatch(workflow, /^      - main\s*$/m);
  assert.match(workflow, /^    environment: production\s*$/m);
});
