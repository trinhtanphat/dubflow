import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const scriptUrl = new URL('../scripts/verify-production-media-fixture.mjs', import.meta.url);
const workflowUrl = new URL('../.github/workflows/production-media-fixture.yml', import.meta.url);

test('production media fixture runner is checked in and remains verification-only', () => {
  assert.equal(fs.existsSync(scriptUrl), true, 'missing production media fixture runner');
  assert.equal(fs.existsSync(workflowUrl), true, 'missing production media fixture workflow');

  const script = fs.readFileSync(scriptUrl, 'utf8');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(script, /yupvox\.qs3d\.site/);
  assert.match(script, /\/api\/projects/);
  assert.match(script, /\/process/);
  assert.match(script, /\/export/);
  assert.match(script, /video\/mp4/);
  assert.match(workflow, /verify-production-media-fixture\.mjs/);
  assert.doesNotMatch(`${script}\n${workflow}`, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
});
