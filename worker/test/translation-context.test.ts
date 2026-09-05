import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// This source-level contract keeps the schema/provenance surface reviewable before behavioral D1 tests.
const migrationPath = 'migrations/0006_translation_context.sql';
const contextPath = 'worker/src/services/translation/context.ts';
const repositoryPath = 'worker/src/db/translation-context.ts';
const segmentsPath = 'worker/src/db/segments.ts';

describe('Phase 4A translation context storage contract', () => {
  it('declares the project context, segment provenance, glossary table, and revision triggers', () => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/translation_style\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'neutral'/);
    expect(migration).toMatch(/translation_context_revision\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+1/);
    expect(migration).toMatch(/ALTER TABLE segments ADD COLUMN translation_context_revision INTEGER/);
    expect(migration).toMatch(/CREATE TABLE project_glossary_entries/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX idx_project_glossary_unique/);
    expect(migration).toMatch(/CREATE TRIGGER trg_project_glossary_insert_revision/);
    expect(migration).toMatch(/CREATE TRIGGER trg_project_glossary_update_revision/);
    expect(migration).toMatch(/CREATE TRIGGER trg_project_glossary_delete_revision/);
  });

  it('declares the canonical context types and revision-aware repository surface', () => {
    expect(existsSync(contextPath)).toBe(true);
    expect(existsSync(repositoryPath)).toBe(true);
    if (!existsSync(contextPath) || !existsSync(repositoryPath)) return;

    const contextSource = readFileSync(contextPath, 'utf8');
    const repositorySource = readFileSync(repositoryPath, 'utf8');
    expect(contextSource).toMatch(/neutral.*natural.*formal.*casual.*cinematic/s);
    expect(contextSource).toMatch(/MAX_GLOSSARY_ENTRIES\s*=\s*200/);
    expect(contextSource).toMatch(/MAX_CONTEXT_PAYLOAD_BYTES\s*=\s*128\s*\*\s*1024/);
    expect(contextSource).toMatch(/function normalizeGlossaryKey/);
    expect(contextSource).toMatch(/function isTranslationContextActive/);
    expect(repositorySource).toMatch(/interface TranslationContextStore/);
    expect(repositorySource).toMatch(/class TranslationContextRepository/);
    expect(repositorySource).toMatch(/TRANSLATION_CONTEXT_CONFLICT/);
    expect(repositorySource).toMatch(/GLOSSARY_ENTRY_CONFLICT/);
    expect(repositorySource).toMatch(/GLOSSARY_LIMIT_REACHED/);
  });

  it('extends persisted segment translation results with contextual provenance', () => {
    const source = readFileSync(segmentsPath, 'utf8');
    expect(source).toMatch(/translationContextRevision:\s*number\s*\|\s*null/);
    expect(source).toMatch(/translation_context_revision/);
    expect(source).toMatch(/contextRevision\?:\s*number\s*\|\s*null/);
    expect(source).toMatch(/SET translated_text = \?, translation_engine = \?, translation_context_revision = \?/);
  });
});
