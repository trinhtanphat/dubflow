import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';

const player = read('src/features/player/VideoStage.tsx');
const timeline = read('src/features/timeline/Timeline.tsx');
const timelineTests = read('src/features/timeline/Timeline.test.tsx');
const editingTests = read('src/features/timeline/editing.test.ts');
const splitTests = read('worker/test/segment-split.test.ts');
const shell = [read('src/app/StudioShell.tsx'), read('src/app/StudioShellBase.tsx')].join('\n');
const shellCommands = read('src/app/studioCommands.ts');
const shortcuts = read('src/app/shortcuts.ts');
const inspector = read('src/features/transcript/ScriptInspector.tsx');
const autosave = read('src/app/segmentAutosaveCoordinator.ts');
const conflictNotice = read('src/features/transcript/SegmentConflictNotice.tsx');
const history = read('src/app/editorHistory.ts');
const appCss = read('src/app/app.css');
const workflow = read('.github/workflows/ci.yml');
const wrangler = read('wrangler.jsonc');

test('V2 acceptance: production player uses real project media', () => {
  assert.match(player, /mediaUrlForProject\(project\)/);
  assert.match(player, /<video[\s\S]*?src=\{mediaUrl\}/);
  assert.match(player, /onTimeUpdate=.*setPlayhead/s);
  assert.match(player, /requestFullscreen/);
});

test('V2 acceptance: timeline supports select, move, resize, split, zoom and playhead editing', () => {
  assert.match(timeline, /type SegmentEditIntent =[\s\S]*kind: 'move'[\s\S]*kind: 'resize'/);
  assert.match(timeline, /dispatch\(\{ type: 'selectSegment'/);
  assert.match(timeline, /onSplitSelected\?\(\)|onSplitSelected\(\)/);
  assert.match(timeline, /setTimelineZoom/);
  assert.match(timeline, /timeline-playhead-handle/);
  assert.match(timelineTests, /data-segment-editing|Kéo playhead/);
  assert.match(editingTests, /clampMoveTiming/);
  assert.match(editingTests, /clampResizeTiming/);
  assert.match(splitTests, /split/i);
});

test('V2 acceptance: editor mutations retain revision-aware undo, redo, autosave and conflict recovery', () => {
  assert.match(shell, /persistUndo/);
  assert.match(shell, /persistRedo/);
  assert.match(shell, /useSegmentAutosave/);
  assert.match(shell, /SegmentVersionConflictError/);
  assert.match(history, /EditorMutation/);
  assert.match(autosave, /conflict|version/i);
  assert.match(conflictNotice, /onUseServer/);
  assert.match(conflictNotice, /onReapply/);
});

test('V2 acceptance: inspector exposes Script, Characters, Voice and AI with translation choices', () => {
  assert.match(inspector, /id: 'script', label: 'Kịch bản'/);
  assert.match(inspector, /id: 'characters', label: 'Nhân vật'/);
  assert.match(inspector, /id: 'voice', label: 'Giọng nói'/);
  assert.match(inspector, /id: 'ai', label: 'AI'/);
  assert.match(inspector, /role="tablist"/);
  assert.match(inspector, /value="workers-ai">Workers AI/);
  assert.match(inspector, /value="google">Google/);
  assert.match(inspector, /value="compare">So sánh/);
});

test('V2 acceptance: command palette is live and keyboard actions are centralized', () => {
  assert.doesNotMatch(shell, /onOpenCommands=\{\(\) => \{\}\}/);
  assert.match(shell, /<CommandPalette/);
  assert.match(shell, /setCommandPaletteOpen\(true\)/);
  assert.match(shellCommands, /split-segment/);
  assert.match(shellCommands, /open-inspector/);
  for (const action of [
    'open-commands',
    'undo',
    'redo',
    'split',
    'zoom-in',
    'zoom-out',
    'toggle-playback',
    'seek-back-small',
    'seek-forward-large',
    'escape',
  ]) {
    assert.ok(shortcuts.includes(`'${action}'`), `shortcut resolver must expose ${action}`);
  }
});

test('V2 acceptance: visual lip-sync fails closed and reduced-motion is honored', () => {
  assert.match(inspector, /visualLipSyncAvailable = false/);
  assert.match(inspector, /disabled=\{!visualLipSyncAvailable\}/);
  assert.match(inspector, /effectiveLipSyncEnabled = visualLipSyncAvailable && lipSyncEnabled/);
  assert.match(appCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(appCss, /animation-duration: 0\.01ms/);
  assert.match(appCss, /transition-duration: 0\.01ms/);
});

test('V2 acceptance: CI qualifies verify, Wrangler and both reference viewports', () => {
  assert.match(workflow, /run: npm run verify/);
  assert.match(workflow, /run: npx wrangler deploy --dry-run/);
  assert.match(workflow, /--window-size=1448,1086/);
  assert.match(workflow, /--window-size=1364,767/);
  assert.match(workflow, /Upload reference screenshot/);
});

test('V2 acceptance: canonical production hostname remains yupvox.qs3d.site', () => {
  assert.match(wrangler, /"pattern": "yupvox\.qs3d\.site"/);
  assert.match(wrangler, /"custom_domain": true/);
});
