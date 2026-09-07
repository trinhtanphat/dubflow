import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const CONFIG = 'wrangler.aac-precompiled-spike.jsonc';
const ENTRY = 'worker/src/spikes/aac-precompiled-worker.ts';

test('precompiled AAC Wasm module is executed inside local workerd', () => {
  assert.equal(existsSync(CONFIG), true, `${CONFIG} must exist`);
  assert.equal(existsSync(ENTRY), true, `${ENTRY} must exist`);
});
