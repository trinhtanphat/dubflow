import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('migrations/0009_multilanguage_variants.sql');

test('Phase 4C keeps one canonical project while adding exact target-language variants', () => {
  assert.match(migration, /ALTER TABLE projects ADD COLUMN target_languages_revision INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /CREATE TABLE(?: IF NOT EXISTS)? project_target_languages/);
  assert.match(migration, /PRIMARY KEY \(project_id, target_language\)/);
  for (const language of ['vi', 'en', 'zh', 'ja', 'ko']) assert.match(migration, new RegExp(`'${language}'`));
  for (const status of ['pending', 'translating', 'needs_review', 'ready', 'exporting', 'completed', 'failed']) {
    assert.match(migration, new RegExp(`'${status}'`));
  }
  assert.match(migration, /INSERT(?: OR IGNORE)? INTO project_target_languages[\s\S]*SELECT[\s\S]*'vi'/);
});

test('Phase 4C stores translation variants separately and backfills Vietnamese compatibility state', () => {
  assert.match(migration, /CREATE TABLE(?: IF NOT EXISTS)? segment_translations/);
  assert.match(migration, /UNIQUE \(segment_id, target_language\)|PRIMARY KEY \(segment_id, target_language\)/);
  assert.match(migration, /translation_context_revision/);
  assert.match(migration, /version INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /INSERT(?: OR IGNORE)? INTO segment_translations[\s\S]*SELECT[\s\S]*'vi'/);
  assert.match(migration, /translated_text/);
  assert.match(migration, /translation_engine/);
  assert.match(migration, /translation_status/);
});

test('Phase 4C stores immutable target/output export attempts and backfills legacy Vietnamese dubbed export', () => {
  assert.match(migration, /CREATE TABLE(?: IF NOT EXISTS)? project_exports/);
  assert.match(migration, /id TEXT PRIMARY KEY/);
  assert.match(migration, /target_language TEXT NOT NULL/);
  assert.match(migration, /output_mode TEXT NOT NULL/);
  assert.match(migration, /'dubbed'/);
  assert.match(migration, /'subtitles'/);
  assert.match(migration, /export_object_key/);
  assert.match(migration, /subtitle_object_key/);
  assert.match(migration, /INSERT(?: OR IGNORE)? INTO project_exports[\s\S]*export_object_key IS NOT NULL/);
});

test('Phase 4C makes glossary uniqueness and revision target-aware without making style target-specific', () => {
  assert.match(migration, /ALTER TABLE project_glossary_entries ADD COLUMN target_language TEXT NOT NULL DEFAULT 'vi'/);
  assert.match(migration, /DROP INDEX IF EXISTS idx_project_glossary_unique/);
  assert.match(migration, /CREATE UNIQUE INDEX[\s\S]*project_id, target_language, source_term_key, case_sensitive/);
  assert.match(migration, /DROP TRIGGER IF EXISTS trg_project_glossary_update_revision/);
  assert.match(migration, /AFTER UPDATE OF[\s\S]*target_language/);
  assert.match(migration, /OLD\.target_language IS NOT NEW\.target_language/);
  assert.doesNotMatch(migration, /translation_style[^;]*target_language/i);
});
