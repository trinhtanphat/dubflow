import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectInput, ProjectInputError } from '../build/domain/project.js';
import { healthPayload } from '../build/routes/health.js';

test('health payload identifies DubFlow foundation phase', () => {
  assert.deepEqual(healthPayload(), { ok: true, service: 'dubflow', phase: 'foundation' });
});

test('project input defaults target language to Vietnamese', () => {
  assert.deepEqual(normalizeProjectInput({ title: ' Tập 01 ', sourceLanguage: 'zh' }), {
    title: 'Tập 01',
    sourceLanguage: 'zh',
    targetLanguage: 'vi',
  });
});

test('project input accepts configured source languages', () => {
  for (const sourceLanguage of ['auto', 'zh', 'en', 'ja', 'ko']) {
    assert.equal(normalizeProjectInput({ title: 'Episode', sourceLanguage }).sourceLanguage, sourceLanguage);
  }
});

test('project input rejects unsupported source and non-Vietnamese target', () => {
  assert.throws(() => normalizeProjectInput({ title: 'Episode', sourceLanguage: 'fr' }), ProjectInputError);
  assert.throws(() => normalizeProjectInput({ title: 'Episode', sourceLanguage: 'en', targetLanguage: 'en' }), ProjectInputError);
});
