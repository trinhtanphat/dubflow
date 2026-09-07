import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProductionMediaFixture } from '../scripts/verify-production-media-fixture.mjs';

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
  assert.match(workflow, /worker\/src\/services\/asr\/workers-ai\.ts/);
  assert.doesNotMatch(`${script}\n${workflow}`, /wrangler\s+deploy|cloudflare-workers-build-deploy|cloudflare-gateway-workers-build-deploy/);
});

test('production media fixture preflights the qualified Vietnamese ElevenLabs provider before project creation', async () => {
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
        provider: 'elevenlabs',
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
    assert.equal(calls.some((url) => url === `${origin}/api/projects`), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
