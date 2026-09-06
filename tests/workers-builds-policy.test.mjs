import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const deployWorkflowUrl = new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url);
const ciWorkflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const policy = fs.readFileSync(new URL('../docs/DEPLOYMENT-POLICY.md', import.meta.url), 'utf8');

test('GitHub Actions never performs production deploys', () => {
  assert.equal(fs.existsSync(deployWorkflowUrl), false, 'remove the GitHub production deploy workflow');
  assert.doesNotMatch(ciWorkflow, /wrangler\s+deploy(?!\s+--dry-run)/i);
  assert.doesNotMatch(ciWorkflow, /CLOUDFLARE_API_TOKEN/);
});

test('Cloudflare Workers Builds is the only production deployment lane', () => {
  assert.match(policy, /Cloudflare Workers Builds/i);
  assert.match(policy, /main/i);
  assert.match(policy, /automatic(?:ally)? build/i);
  assert.match(policy, /automatic(?:ally)? deploy/i);
  assert.match(policy, /GitHub Actions.*CI/i);
  assert.match(policy, /must not deploy/i);
});
