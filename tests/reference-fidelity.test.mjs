import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const tokens = read('src/styles/tokens.css');
const main = read('src/main.tsx');
const referenceCss = read('src/styles/reference-fidelity.css');
const uploadPanel = read('src/features/upload/UploadPanel.tsx');
const studioShell = read('src/app/StudioShell.tsx');

test('defines canonical 1448x1086 reference geometry tokens', () => {
  assert.match(tokens, /--yv-ref-topbar-height:\s*76px/);
  assert.match(tokens, /--yv-ref-footer-height:\s*66px/);
  assert.match(tokens, /--yv-ref-rail-width:\s*304px/);
  assert.match(tokens, /--yv-ref-player-gutter:\s*16px/);
});

test('loads reference fidelity CSS after the existing app styles', () => {
  const referenceImport = "import './styles/reference-fidelity.css';";
  assert.ok(main.includes(referenceImport));
  assert.ok(main.indexOf(referenceImport) > main.indexOf("import './app/app.css';"));
});

test('uses canonical geometry variables in the desktop reference layer', () => {
  assert.match(referenceCss, /@media\s*\(min-width:\s*1400px\)/);
  assert.match(referenceCss, /var\(--yv-ref-rail-width\)/);
  assert.match(referenceCss, /var\(--yv-ref-footer-height\)/);
});

test('orders the live left rail as upload, speakers, languages, then dubbing action', () => {
  assert.match(uploadPanel, /speakerSection\?:\s*ReactNode/);
  const drop = uploadPanel.indexOf('reference-drop-zone');
  const speakers = uploadPanel.indexOf('{speakerSection}');
  const languages = uploadPanel.indexOf('Ngôn ngữ gốc');
  const action = uploadPanel.indexOf('Bắt đầu Dubbing AI');
  assert.ok(drop >= 0 && speakers > drop && languages > speakers && action > languages);
  assert.match(studioShell, /speakerSection=\{<SpeakerList/);
  assert.doesNotMatch(studioShell, /<UploadPanel[^>]*\/>\s*<SpeakerList/);
});

test('activates reference fidelity on the production studio shell', () => {
  assert.match(studioShell, /app-shell studio-pro-shell reference-fidelity mobile-panel--/);
});