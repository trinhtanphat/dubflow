import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf8');

test('Phase 4D forward persistence contract is present without rewriting historical migrations', () => {
  assert.ok(existsSync(url('migrations/0011_audio_separation.sql')), '0011_audio_separation.sql must exist');
  const migration = read('migrations/0011_audio_separation.sql');
  assert.match(migration, /source_revision/i);
  assert.match(migration, /audio_separations/i);
  assert.match(migration, /mix_mode/i);
  assert.match(migration, /dubbed_only/);
  assert.match(migration, /preserve_background/);

  const projects = read('worker/src/db/projects.ts');
  assert.match(projects, /sourceRevision/);
  assert.match(projects, /source_revision\s*=\s*source_revision\s*\+\s*1/);

  assert.ok(existsSync(url('worker/src/db/audio-separation.ts')), 'AudioSeparationRepository must exist');
  const separation = read('worker/src/db/audio-separation.ts');
  assert.match(separation, /class AudioSeparationRepository/);
  assert.match(separation, /projects\/\$\{projectId\}\/stems\/\$\{sourceRevision\}/);

  const exportsSource = read('worker/src/db/project-exports.ts');
  assert.match(exportsSource, /mixMode/);
  assert.match(exportsSource, /mix_mode/);
});
