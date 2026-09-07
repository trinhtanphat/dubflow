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

test('Workers Builds policy documents Stream runtime secrets without requiring Container permissions', () => {
  const policy = fs.readFileSync(policyUrl, 'utf8');
  assert.match(policy, /Cloudflare Stream/i);
  assert.match(policy, /CLOUDFLARE_STREAM_API_TOKEN/);
  assert.match(policy, /STREAM_SOURCE_SIGNING_SECRET/);
  assert.match(policy, /Settings\s*>\s*Builds/i);
  assert.match(policy, /No `Containers Edit` permission is required/i);
  assert.match(policy, /do not.*GitHub.*deploy/is);
});
