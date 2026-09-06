import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTwoStemFiles, validateStemSeparationInput } from './stem-separation.mjs';

test('classifies common two-stem provider filenames without depending on ZIP ordering', () => {
  assert.deepEqual(
    classifyTwoStemFiles(['instrumental.wav', 'vocals.wav']),
    { dialogue: 'vocals.wav', background: 'instrumental.wav' },
  );
  assert.deepEqual(
    classifyTwoStemFiles(['stems/no_vocals.wav', 'stems/vocal.wav']),
    { dialogue: 'stems/vocal.wav', background: 'stems/no_vocals.wav' },
  );
});

test('rejects ambiguous or incomplete two-stem archives', () => {
  assert.throws(() => classifyTwoStemFiles(['stem-1.wav', 'stem-2.wav']), /identify/i);
  assert.throws(() => classifyTwoStemFiles(['vocals.wav']), /exactly two/i);
});

test('validates project scope and source revision', () => {
  assert.deepEqual(validateStemSeparationInput({
    projectId: 'p1',
    objectKey: 'projects/p1/source/a.mp4',
    sourceRevision: 'rev-1',
  }), {
    projectId: 'p1',
    objectKey: 'projects/p1/source/a.mp4',
    sourceRevision: 'rev-1',
  });
  assert.throws(() => validateStemSeparationInput({
    projectId: 'p1', objectKey: 'projects/p2/source/a.mp4', sourceRevision: 'rev-1',
  }), /outside the project/i);
  assert.throws(() => validateStemSeparationInput({
    projectId: 'p1', objectKey: 'projects/p1/source/a.mp4', sourceRevision: '../bad',
  }), /sourceRevision/i);
});
