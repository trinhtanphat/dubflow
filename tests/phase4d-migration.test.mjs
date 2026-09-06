import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf8');

test('Phase 4D forward persistence matches the approved source-revision and separation contract', () => {
  assert.ok(existsSync(url('migrations/0011_audio_separation.sql')), '0011_audio_separation.sql must exist');
  const migration = read('migrations/0011_audio_separation.sql');
  assert.match(migration, /source_revision\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  assert.match(migration, /UPDATE\s+projects[\s\S]*source_revision\s*=\s*1[\s\S]*source_object_key\s+IS\s+NOT\s+NULL/i);
  assert.match(migration, /CREATE\s+TABLE\s+project_audio_separations/i);
  assert.match(migration, /source_object_key\s+TEXT\s+NOT\s+NULL/i);
  assert.match(migration, /source_size_bytes\s+INTEGER/i);
  assert.match(migration, /completed_at\s+TEXT/i);
  assert.match(migration, /queued[^)]*running[^)]*completed[^)]*failed[^)]*invalidated/i);
  assert.match(migration, /mix_mode/i);
  assert.match(migration, /dubbed_only/);
  assert.match(migration, /preserve_background/);

  const projects = read('worker/src/db/projects.ts');
  assert.match(projects, /sourceRevision/);
  assert.match(projects, /source_revision\s*=\s*source_revision\s*\+\s*1/);

  assert.ok(existsSync(url('worker/src/db/audio-separation.ts')), 'AudioSeparationRepository must exist');
  const separation = read('worker/src/db/audio-separation.ts');
  assert.match(separation, /class AudioSeparationRepository/);
  assert.match(separation, /project_audio_separations/);
  assert.match(separation, /projects\/\$\{projectId\}\/separation\/\$\{sourceRevision\}/);
  assert.match(separation, /sourceObjectKey/);
  assert.match(separation, /sourceSizeBytes/);

  const exportsSource = read('worker/src/db/project-exports.ts');
  assert.match(exportsSource, /mixMode/);
  assert.match(exportsSource, /mix_mode/);
});
