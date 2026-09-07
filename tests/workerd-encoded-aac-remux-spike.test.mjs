import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const CONFIG = 'wrangler.encoded-aac-remux-spike.jsonc';
const WORKER_PORT = 8802;
const FIXTURE_PORT = 8803;
const WORKER_ORIGIN = `http://127.0.0.1:${WORKER_PORT}`;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/fixture.mp4`;

function readFixture() {
  const source = readFileSync('worker/test/fixtures/r2-remux-fixtures.ts', 'utf8');
  const match = source.match(/export const H264_AAC_MP4_BASE64 = '([^']+)'/);
  assert.ok(match?.[1], 'H264_AAC_MP4_BASE64 fixture must be present');
  return Buffer.from(match[1], 'base64');
}

function createFixtureServer(bytes) {
  return createServer((request, response) => {
    if (request.url !== '/fixture.mp4') {
      response.writeHead(404).end();
      return;
    }

    const common = {
      'accept-ranges': 'bytes',
      'content-type': 'video/mp4',
    };
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, { ...common, 'content-length': String(bytes.length) });
      if (request.method === 'HEAD') response.end();
      else response.end(bytes);
      return;
    }

    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { ...common, 'content-range': `bytes */${bytes.length}` }).end();
      return;
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : bytes.length - 1;
    if (!Number.isInteger(start) || start < 0 || start >= bytes.length) {
      response.writeHead(416, { ...common, 'content-range': `bytes */${bytes.length}` }).end();
      return;
    }
    const end = Math.min(requestedEnd, bytes.length - 1);
    const body = bytes.subarray(start, end + 1);
    response.writeHead(206, {
      ...common,
      'content-length': String(body.length),
      'content-range': `bytes ${start}-${end}/${bytes.length}`,
    });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  });
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function diagnostics(stdout, stderr) {
  return [stdout.trim() ? `stdout:\n${stdout.slice(-4000)}` : '', stderr.trim() ? `stderr:\n${stderr.slice(-4000)}` : '']
    .filter(Boolean)
    .join('\n');
}

async function waitForWorker(child, getDiagnostics) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited before readiness (exit ${child.exitCode}).\n${getDiagnostics()}`);
    }
    try {
      const response = await fetch(`${WORKER_ORIGIN}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`local workerd did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${getDiagnostics()}`);
}

test('encoded AAC packets demux and remux to an MP4 chunk inside local workerd', { timeout: 60_000 }, async () => {
  const fixtureServer = createFixtureServer(readFixture());
  await listen(fixtureServer, FIXTURE_PORT);

  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--local', '--config', CONFIG, '--ip', '127.0.0.1', '--port', String(WORKER_PORT), '--log-level', 'error'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const getDiagnostics = () => diagnostics(stdout, stderr);

  try {
    await waitForWorker(child, getDiagnostics);
    const response = await fetch(`${WORKER_ORIGIN}/transmux?source=${encodeURIComponent(FIXTURE_URL)}`);
    const body = await response.json().catch(() => null);
    assert.equal(response.status, 200, `transmux failed: ${JSON.stringify(body)}\n${getDiagnostics()}`);
    assert.equal(body?.ok, true);
    assert.ok(body.chunkCount >= 1);
    assert.equal(body.firstBoxType, 'ftyp');
    assert.ok(body.byteLengths.every((value) => Number.isInteger(value) && value > 0));
    assert.ok(body.durationsMs.every((value) => Number.isInteger(value) && value > 0 && value <= 300_000));
    assert.ok(body.offsetsMs.every((value, index, values) => Number.isInteger(value) && value >= 0 && (index === 0 || value >= values[index - 1])));
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await close(fixtureServer);
  }
});
