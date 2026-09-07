import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');

test('browser-local inference pins Transformers.js exactly', () => {
  assert.match(
    packageSource,
    /"@huggingface\/transformers"\s*:\s*"4\.2\.0"/,
    'zero-cost browser inference must exact-pin @huggingface/transformers 4.2.0',
  );
});
