import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => /^\d{4}_.*\.sql$/.test(name));
const policy = read('docs/DEPLOYMENT-POLICY.md');
const ci = read('.github/workflows/ci.yml');
const wrangler = JSON.parse(read('wrangler.jsonc'));
const app = read('worker/src/app.ts');
const shares = read('worker/src/db/shares.ts');
const shareRoutes = read('worker/src/routes/shares.ts');

const hasMigration = (name) => migrations.includes(name);

test('main reconciliation keeps migration history collision-free and adds a forward Phase 4C migration', () => {
  assert.equal(hasMigration('0009_multilang_exports.sql'), true, 'keep already-landed main migration 0009');
  assert.equal(hasMigration('0010_multilanguage_variants.sql'), true, 'add forward migration 0010 for canonical Phase 4C schema');
  const numbers = migrations.map((name) => name.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, 'migration numbers must be unique');
  if (hasMigration('0010_multilanguage_variants.sql')) {
    const forward = read('migrations/0010_multilanguage_variants.sql');
    assert.match(forward, /project_target_languages/);
    assert.match(forward, /translation_context_revision/);
    assert.match(forward, /output[^\n]*(?:dubbed|subtitles)/s);
    assert.match(forward, /export_id/);
  }
});

test('main reconciliation preserves the single Workers Builds production lane', () => {
  assert.match(policy, /Cloudflare Workers Builds is the only production deployment lane/i);
  assert.match(policy, /GitHub Actions is CI only/i);
  assert.equal(existsSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url)), false);
  assert.doesNotMatch(ci, /wrangler\s+deploy(?!\s+--dry-run)/i);
});

test('main reconciliation keeps the production account while retaining the language workflow', () => {
  assert.equal(wrangler.account_id, '6c5207813df3d5b83b9508125e0e9e12');
  assert.ok(wrangler.workflows?.some((entry) => entry.binding === 'LANGUAGE_TRANSLATION_WORKFLOW' && entry.class_name === 'LanguageTranslationWorkflow'));
});

test('main reconciliation keeps one active Phase 4C backend source of truth', () => {
  assert.doesNotMatch(app, /projectTargetsRoutes|batchExportRoutes/);
  assert.doesNotMatch(app, /MultilangRepository/);
  assert.match(app, /languageRoutes/);
  assert.match(app, /translationVariantRoutes/);
  assert.match(app, /exportRoutes/);
});

test('main reconciliation preserves concrete export sharing on canonical project exports', () => {
  assert.match(shares, /exportId/);
  assert.match(shares, /export_id/);
  assert.match(shareRoutes, /ProjectExportRepository|ProjectExportStore/);
  assert.doesNotMatch(shareRoutes, /MultilangRepository|MultilangStore/);
  assert.match(shareRoutes, /EXPORT_NOT_READY/);
});
