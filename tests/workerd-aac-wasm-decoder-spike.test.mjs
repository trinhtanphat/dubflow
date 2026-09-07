import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const CONFIG = 'wrangler.aac-decoder-spike.jsonc';
const ENTRY = 'worker/src/spikes/aac-wasm-decoder-worker.ts';
const PORT = 8797;
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function waitForLocalWorker(child) {
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited before the local Worker became ready (exit ${child.exitCode}).`);
    }
    try {
      const response = await fetch(`${ORIGIN}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`local workerd did not become ready: ${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

test('AAC WASM decoder bundles and decodes a real ADTS frame inside local workerd', { timeout: 45_000 }, async () => {
  assert.equal(existsSync(CONFIG), true, `${CONFIG} must exist for the workerd compatibility spike`);
  assert.equal(existsSync(ENTRY), true, `${ENTRY} must exist for the workerd compatibility spike`);

  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--local', '--config', CONFIG, '--ip', '127.0.0.1', '--port', String(PORT), '--log-level', 'error'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForLocalWorker(child);
    const response = await fetch(`${ORIGIN}/decode`);
    const body = await response.json().catch(() => null);
    assert.equal(response.status, 200, `decode failed: ${JSON.stringify(body)}\n${stderr.slice(-4000)}`);
    assert.equal(body?.ok, true);
    assert.equal(typeof body?.sampleRate, 'number');
    assert.ok(body.sampleRate >= 8_000);
    assert.equal(typeof body?.samplesDecoded, 'number');
    assert.ok(body.samplesDecoded > 0);
    assert.equal(typeof body?.channelCount, 'number');
    assert.ok(body.channelCount >= 1);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(2_000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
