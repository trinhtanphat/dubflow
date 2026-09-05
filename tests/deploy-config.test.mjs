import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('deployment config contains no fake resource placeholder', () => {
  const d1 = config.d1_databases?.find((item) => item.binding === 'DB');
  assert.ok(d1);
  assert.notEqual(d1.database_id, 'REPLACE_WITH_D1_DATABASE_ID');
});

test('deployment uses Wrangler with automatic resource provisioning support', () => {
  const wrangler = pkg.devDependencies?.wrangler ?? '';
  const match = wrangler.match(/(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `invalid Wrangler version: ${wrangler}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  assert.ok(major > 4 || (major === 4 && minor >= 45), `Wrangler ${wrangler} is older than 4.45.0`);
});

test('production custom domain stays pinned to yupvox.qs3d.site', () => {
  assert.deepEqual(config.routes, [{ pattern: 'yupvox.qs3d.site', custom_domain: true }]);
});

test('deployment config defines the FFmpeg container Durable Object', () => {
  const container = config.containers?.find((item) => item.class_name === 'FfmpegContainer');
  assert.ok(container, 'missing FfmpegContainer container definition');
  assert.equal(container.image, './containers/ffmpeg/Dockerfile');
  assert.equal(container.instance_type, 'standard-1');

  const binding = config.durable_objects?.bindings?.find((item) => item.name === 'FFMPEG_CONTAINER');
  assert.deepEqual(binding, { name: 'FFMPEG_CONTAINER', class_name: 'FfmpegContainer' });
  assert.deepEqual(config.exports?.FfmpegContainer, {
    type: 'durable-object',
    state: 'created',
    storage: 'sqlite',
  });
});
