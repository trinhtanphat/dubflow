import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TARGET_LANGUAGES, isTargetLanguage } from '../src/domain/language';

const readRepoFile = (relativePath: string) => readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

describe('Phase 4C canonical target domain and schema', () => {
  it('defines exactly the five canonical Phase 4C target languages', () => {
    expect(TARGET_LANGUAGES).toEqual(['vi', 'en', 'zh', 'ja', 'ko']);
    expect(isTargetLanguage('ja')).toBe(true);
    expect(isTargetLanguage('fr')).toBe(false);
  });

  it('creates language variant tables and Vietnamese compatibility backfills', () => {
    const sql = readRepoFile('migrations/0009_multilanguage_variants.sql');
    expect(sql).toContain('ADD COLUMN target_languages_revision');
    expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? project_target_languages/);
    expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? segment_translations/);
    expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? project_exports/);
    expect(sql).toMatch(/INSERT(?: OR IGNORE)? INTO project_target_languages[\s\S]*'vi'/);
    expect(sql).toContain("target_language TEXT NOT NULL DEFAULT 'vi'");
  });

  it('maps projects.target_languages_revision without widening the legacy targetLanguage DTO', () => {
    const source = readRepoFile('worker/src/db/projects.ts');
    expect(source).toContain('targetLanguagesRevision: number');
    expect(source).toContain('target_languages_revision: number');
    expect(source).toMatch(/PROJECT_COLUMNS[\s\S]*target_languages_revision/);
    expect(source).toMatch(/targetLanguagesRevision:\s*row\.target_languages_revision/);
    expect(source).toContain("targetLanguage: 'vi'");
  });
});
