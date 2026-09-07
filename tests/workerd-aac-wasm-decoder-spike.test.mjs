import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const CONFIG = 'wrangler.aac-decoder-spike.jsonc';
const ENTRY = 'worker/src/spikes/aac-wasm-decoder-worker.ts';
const GENERATED_WASM = 'worker/src/spikes/generated/aac-decoder.wasm';
const PORT = 8797;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function diagnosticTail(stdout, stderr) {
  return [
    stdout.trim() ? `stdout:\n${stdout.slice(-4000)}` : '',
    stderr.trim() ? `stderr:\n${stderr.slice(-4000)}` : '',
  ].filter(Boolean).join('\n');
}

async function extractPrecompiledDecoderWasm() {
  const originalCompile = WebAssembly.compile;
  const compileInputs = [];
  WebAssembly.compile = async (source) => {
    const bytes = source instanceof ArrayBuffer
      ? new Uint8Array(source.slice(0))
      : new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    compileInputs.push(bytes);
    return originalCompile.call(WebAssembly, source);
  };

  try {
    const { AACDecoder } = await import('@wasm-audio-decoders/aac');
    const decoder = new AACDecoder();
    await decoder.ready;
    decoder.free();
  } finally {
    WebAssembly.compile = originalCompile;
  }

  assert.ok(compileInputs.length >= 2, 'decoder initialization must expose puff and AAC Wasm compile inputs');
  const decoderWasm = compileInputs.reduce((largest, current) => (
    current.byteLength > largest.byteLength ? current : largest
  ));
  assert.deepEqual([...decoderWasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'captured decoder payload must be Wasm');
  assert.ok(decoderWasm.byteLength > 32_000, 'captured AAC decoder Wasm must be non-trivial');

  mkdirSync('worker/src/spikes/generated', { recursive: true });
  writeFileSync(GENERATED_WASM, decoderWasm);
}

async function waitForLocalWorker(child, getDiagnostics) {
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      const diagnostics = getDiagnostics();
      throw new Error(
        `wrangler dev exited before the local Worker became ready (exit ${child.exitCode}).${diagnostics ? `\n${diagnostics}` : ''}`,
      );
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
  const diagnostics = getDiagnostics();
  throw new Error(
    `local workerd did not become ready: ${lastError instanceof Error ? lastError.message : 'unknown error'}${diagnostics ? `\n${diagnostics}` : ''}`,
  );
}

test('AAC WASM decoder bundles and decodes a real ADTS frame inside local workerd', { timeout: 45_000 }, async () => {
  assert.equal(existsSync(CONFIG), true, `${CONFIG} must exist for the workerd compatibility spike`);
  assert.equal(existsSync(ENTRY), true, `${ENTRY} must exist for the workerd compatibility spike`);
  await extractPrecompiledDecoderWasm();
  assert.equal(existsSync(GENERATED_WASM), true, 'precompiled AAC decoder Wasm must be materialized before Wrangler starts');

  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'dev', '--local', '--config', CONFIG, '--ip', '127.0.0.1', '--port', String(PORT), '--log-level', 'error'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const getDiagnostics = () => diagnosticTail(stdout, stderr);

  try {
    await waitForLocalWorker(child, getDiagnostics);
    const response = await fetch(`${ORIGIN}/decode`);
    const body = await response.json().catch(() => null);
    assert.equal(response.status, 200, `decode failed: ${JSON.stringify(body)}\n${getDiagnostics()}`);
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
