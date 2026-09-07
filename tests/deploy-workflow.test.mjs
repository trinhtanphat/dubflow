import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const deployWorkflowUrl = new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url);
const ciWorkflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const policyUrl = new URL('../docs/DEPLOYMENT-POLICY.md', import.meta.url);

test('GitHub Actions never performs production deploys', () => {
  assert.equal(fs.existsSync(deployWorkflowUrl), false, 'remove the GitHub production deploy workflow');
  assert.doesNotMatch(ciWorkflow, /wrangler\s+deploy(?!\s+--dry-run)/i);
  assert.doesNotMatch(ciWorkflow, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(ciWorkflow, /cloudflare-workers-build-deploy/i);
});

test('Cloudflare Workers Builds is the only production deployment lane', () => {
  assert.equal(fs.existsSync(policyUrl), true, 'document the deployment policy');
  const policy = fs.readFileSync(policyUrl, 'utf8');
  assert.match(policy, /Cloudflare Workers Builds/i);
  assert.match(policy, /main/i);
  assert.match(policy, /automatic(?:ally)? build/i);
  assert.match(policy, /automatic(?:ally)? deploy/i);
  assert.match(policy, /GitHub Actions.*CI/i);
  assert.match(policy, /must not deploy/i);
});

test('CI validates the exact generated Workers Builds production config before merge', () => {
  assert.match(ciWorkflow, /cloudflare-workers-build-config\.mjs/);
  assert.match(ciWorkflow, /prepareWorkersBuildConfig/);
  assert.match(ciWorkflow, /wrangler\s+deploy\s+--dry-run\s+--config\s+\.wrangler-production\.json/i);
  assert.match(ciWorkflow, /(?:trap[^\n]*|rm\s+-f\s+)\.wrangler-production\.json/i);
});

test('Workers Builds production lane is explicitly container-free on account 2403', () => {
  const policy = fs.readFileSync(policyUrl, 'utf8');
  assert.match(policy, /container-free/i);
  assert.match(policy, /50afb4fd3c4c7a1f3e1bdb7f22d4af7f/i);
  assert.match(policy, /removes `containers`.*`durable_objects`.*`exports`/is);
  assert.match(policy, /without enabling paid Cloudflare Containers/i);
  assert.match(policy, /hard-pins account/i);
  assert.match(policy, /exact generated `\.wrangler-production\.json`/i);
  assert.doesNotMatch(policy, /Containers Edit/i);
});
