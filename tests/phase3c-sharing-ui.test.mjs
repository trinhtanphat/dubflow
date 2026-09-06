import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync('src/main.tsx', 'utf8');

test('Phase 3C loads a dedicated compact sharing surface after the Studio app styles', () => {
  const appStyles = "import './app/app.css';";
  const sharingStyles = "import './features/sharing/sharing.css';";
  assert.ok(main.includes(sharingStyles), 'src/main.tsx must load the sharing stylesheet');
  assert.ok(
    main.indexOf(sharingStyles) > main.indexOf(appStyles),
    'sharing styles must load after the base Studio app styles',
  );

  const css = readFileSync('src/features/sharing/sharing.css', 'utf8');
  assert.match(css, /\.share-panel\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.share-panel\s*\{[^}]*z-index:\s*(?:[3-9]\d|\d{3,})/s);
  assert.match(css, /\.share-panel\s*\{[^}]*width:\s*min\(/s);
  assert.match(css, /\.share-panel\s*\{[^}]*max-height:\s*calc\(100vh\s*-/s);
  assert.match(css, /\.share-panel\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css, /\.share-panel__link-row\s+code\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/s);
});
