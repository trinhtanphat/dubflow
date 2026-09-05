import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const tokens = read('src/styles/tokens.css');
const main = read('src/main.tsx');
const referenceCss = read('src/styles/reference-fidelity.css');
const uploadPanel = read('src/features/upload/UploadPanel.tsx');
const studioShell = read('src/app/StudioShell.tsx');
const videoStage = read('src/features/player/VideoStage.tsx');
const scriptInspector = read('src/features/transcript/ScriptInspector.tsx');
const ci = read('.github/workflows/ci.yml');

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

test('keeps reference fidelity active on common 1364px desktop screens', () => {
  const desktopBreakpoints = [...referenceCss.matchAll(/@media\s*\(min-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));
  assert.ok(desktopBreakpoints.some((value) => value <= 1280), 'reference layer must activate at or below 1280px so 1364px desktop does not fall back to the legacy shell');
  assert.match(referenceCss, /var\(--yv-ref-rail-width\)/);
  assert.match(referenceCss, /var\(--yv-ref-footer-height\)/);
});

test('qualifies the exact 1364x767 desktop viewport in CI', () => {
  assert.match(ci, /--window-size=1364,767/);
  assert.match(ci, /yupvox-1364x767-reference\.png/);
  assert.match(ci, /path:\s*\|[\s\S]*yupvox-v2-2-reference\.png[\s\S]*yupvox-1364x767-reference\.png/);
});

test('installs a CJK font in the Linux screenshot qualification environment', () => {
  assert.match(ci, /fonts-noto-cjk/);
  assert.ok(ci.indexOf('fonts-noto-cjk') < ci.indexOf('Capture reference screenshots'));
});

test('uses a compact-height reference layout instead of clipping the timeline at 1364x767', () => {
  assert.match(referenceCss, /@media\s*\(min-width:\s*1280px\)\s*and\s*\(max-height:\s*820px\)/);
  assert.match(referenceCss, /\.studio-pro-shell\.reference-fidelity \.center-stage\s*\{[^}]*grid-template-rows:/s);
  assert.match(referenceCss, /\.studio-pro-shell\.reference-fidelity \.reference-feature-strip\s*\{[^}]*min-height:/s);
  assert.match(referenceCss, /\.studio-pro-shell\.reference-fidelity \.reference-drop-zone\s*\{[^}]*\n\s*height:\s*96px/s);
});

test('gives Chinese source text an explicit CJK fallback contract', () => {
  assert.match(videoStage, /className="subtitle-source"\s+lang="zh-CN"/);
  assert.match(scriptInspector, /aria-label="Lời thoại gốc"[\s\S]*?lang="zh-CN"/);
  assert.match(referenceCss, /Noto Sans CJK SC|Noto Sans SC/);
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
