import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProductionMediaFixture } from '../scripts/verify-production-media-fixture.mjs';
import './production-browser-piper-fixture.test.mjs';

const scriptUrl = new URL('../scripts/verify-production-media-fixture.mjs', import.meta.url);
const browserScriptUrl = new URL('../scripts/verify-production-browser-piper-fixture.mjs', import.meta.url);
const workflowUrl = new URL('../.github/workflows/production-media-fixture.yml', import.meta.url);
const exportWorkflowUrl = new URL('../worker/src/workflows/ExportWorkflow.ts', import.meta.url);
const exportRouteUrl = new URL('../worker/src/routes/export.ts', import.meta.url);

test('production media fixture runner is checked in and remains verification-only', () => {
  assert.equal(fs.existsSync(scriptUrl), true, 'missing legacy production media fixture runner');
  assert.equal(fs.existsSync(browserScriptUrl), true, 'missing browser-local production fixture runner');
  assert.equal(fs.existsSync(workflowUrl), true, 'missing production media fixture workflow');

  const browserScript = fs.readFileSync(browserScriptUrl, 'utf8');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(browserScript, /yupvox\.qs3d\.site/);
  assert.match(browserScript, /\/api\/projects/);
  assert.match(browserScript, /Process locally \(zero-cost\)/);
  assert.match(browserScript, /client-inference\/vi/);
  assert.match(browserScript, /exports\/vi/);
  assert.match(browserScript, /video\/mp4/);
  assert.doesNotMatch(browserScript, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/process/);
  assert.doesNotMatch(workflow, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
});

test('legacy production media fixture reports sanitized voice capability diagnostics', () => {
  const script = fs.readFileSync(scriptUrl, 'utf8');
  assert.match(script, /\/api\/voice\/capabilities/);
  assert.match(script, /Production voice capability/);
  assert.match(script, /provider/);
  assert.match(script, /configured/);
  assert.match(script, /cloning/);
  assert.match(script, /preview/);
  assert.doesNotMatch(script, /console\.log\([^\n]*(API_KEY|SECRET|TOKEN)/);
});

test('production export admission and workflow share the voice provider selector', () => {
  const exportWorkflow = fs.readFileSync(exportWorkflowUrl, 'utf8');
  const exportRoute = fs.readFileSync(exportRouteUrl, 'utf8');
  assert.match(exportWorkflow, /createVoiceProvider/);
  assert.match(exportRoute, /createVoiceProvider/);
  assert.doesNotMatch(exportWorkflow, /new\s+ElevenLabsVoiceProvider/);
  assert.doesNotMatch(exportRoute, /new\s+ElevenLabsVoiceProvider/);
});

test('production media fixture remains manual-only', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*push:\s*$/m);
  assert.doesNotMatch(workflow, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
});

test('legacy production media fixture still fails closed before project creation when server voice is unavailable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubflow-media-fixture-'));
  const fixturePath = path.join(tempDir, 'fixture.mp4');
  fs.writeFileSync(fixturePath, new Uint8Array([1, 2, 3, 4]));
  const origin = 'https://yupvox.test';
  const calls = [];

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === `${origin}/api/ready`) {
      return json({
        ready: true,
        service: 'dubflow',
        database: 'ready',
        schemaRevision: 14,
        media: { r2: 'ready', remux: 'ready' },
      });
    }
    if (url === `${origin}/api/voice/capabilities`) {
      return json({
        provider: 'workers-ai',
        configured: false,
        languages: ['vi'],
        cloning: false,
        preview: false,
        cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
      });
    }
    if (url === `${origin}/api/projects`) {
      return json({ id: 'project-should-not-be-created' }, 201);
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };

  try {
    await assert.rejects(
      runProductionMediaFixture({ fetchImpl, origin, fixturePath, pollAttempts: 1, pollDelayMs: 0 }),
      /Production voice capability is not ready/,
    );
    assert.deepEqual(calls.slice(0, 2), [
      `${origin}/api/ready`,
      `${origin}/api/voice/capabilities`,
    ]);
    assert.equal(calls.includes(`${origin}/api/projects`), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production browser fixture persists the downloaded MP4 and proves H.264 plus AAC with ffprobe', () => {
  const script = fs.readFileSync(browserScriptUrl, 'utf8');
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(script, /PRODUCTION_MEDIA_OUTPUT_PATH/);
  assert.match(script, /writeFileSync/);
  assert.match(workflow, /PRODUCTION_MEDIA_OUTPUT_PATH/);
  assert.match(workflow, /ffprobe/);
  assert.match(workflow, /codec_name/);
  assert.match(workflow, /h264/);
  assert.match(workflow, /aac/);
});

test('production fixture proves the H.264 elementary stream is packet-preserved', () => {
  const workflow = fs.readFileSync(workflowUrl, 'utf8');

  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /-c:v\s+copy/);
  assert.match(workflow, /production-r2-fixture\.mp4/);
  assert.match(workflow, /production-r2-output\.mp4/);
  assert.match(workflow, /source_video_sha/);
  assert.match(workflow, /output_video_sha/);
});
