import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function source(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

test('Phase 4D frontend owns explicit separation GET and POST client calls', () => {
  const client = source('src/features/export/separationApi.ts');
  assert.match(client, /export\s+(?:async\s+)?function\s+getSeparationStatus/);
  assert.match(client, /\/api\/projects\/\$\{projectId\}\/separation/);
  assert.match(client, /method:\s*['"]POST['"]/);
  assert.match(client, /retry:\s*true/);
});

test('Studio loads status without auto-starting separation and forwards the selected mix mode', () => {
  const studio = source('src/app/StudioShell.tsx');
  assert.match(studio, /getSeparationStatus\(projectId\)/);
  assert.match(studio, /prepareSeparation\(projectId/);
  assert.match(studio, /startLanguageExport\(projectId,\s*exportTarget,\s*exportOutput,\s*mixMode\)/);
  assert.match(studio, /startBatchExport\(projectId,\s*selectedLanguages,\s*exportOutput,\s*mixMode\)/);

  const effects = [...studio.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},\s*\[[^\]]*\]\);/g)].map((match) => match[1]);
  assert.equal(effects.some((body) => /prepareSeparation\(/.test(body)), false, 'opening Studio must never auto-start separation');
});