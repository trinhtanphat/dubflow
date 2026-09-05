# YupVox Studio Pro V2.2 Reference-Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the current Studio Pro V2.2 desktop presentation with the supplied 1448×1086 YupVox reference while preserving the live Cloudflare pipeline, real player/timeline behavior, cloud hydration, persistence, responsive drawers, and truthful capability gates.

**Architecture:** Keep the current `App -> StudioShell -> StudioTopbar` composition and current feature modules as the production source of truth. Add narrowly scoped reference-fidelity presentation hooks and CSS, make only the minimum markup changes needed to restore reference hierarchy/order, and never replace production-capable state or API flows with static mock state.

**Tech Stack:** React 19, TypeScript, Vite 7, Vitest 3, Hono/Cloudflare Workers, Cloudflare Containers/Workflows, CSS modules-by-file imported from `src/main.tsx`, Chromium headless for final desktop screenshot qualification.

**Spec:** `docs/superpowers/specs/2026-09-05-yupvox-v2-2-reference-fidelity-design.md`

## Global Constraints

- Desktop visual qualification viewport is exactly `1448×1086`.
- Reference geometry targets: topbar ≈ `76px`, footer ≈ `66px`, left rail ≈ `304px`, right rail ≈ `304px`, center fills the remainder, player horizontal bounds ≈ `x=320..1128`.
- Preserve R2 multipart upload, Workflow-backed jobs, FFmpeg Container processing, Whisper ASR, D1 persistence, Workers AI/Google translation, cloud hydration, private range media streaming, real HTML video playback, player↔timeline sync, zoom/scroll/seek/drag timeline behavior, and server-backed editor mutations.
- Preserve mobile drawers, semantic regions, keyboard accessibility, visible focus states, and capability-gated unsupported features.
- Do not reintroduce PR #2's monolithic minified stylesheet or old application composition.
- Do not claim `100% pixel-perfect` without an actual pixel-diff metric.
- Production Cloudflare deploy remains manual-only while Container credentials are not externally qualified.

---

### Task 1: Reference geometry tokens and isolated override layer

**Files:**
- Modify: `src/styles/tokens.css`
- Create: `src/styles/reference-fidelity.css`
- Modify: `src/main.tsx`
- Create: `src/app/referenceFidelity.test.ts`

**Interfaces:**
- Consumes: existing YupVox CSS tokens and stylesheet import order.
- Produces: canonical CSS variables `--yv-ref-topbar-height`, `--yv-ref-footer-height`, `--yv-ref-rail-width`, `--yv-ref-player-gutter`, and a last-loaded `.studio-pro-shell.reference-fidelity` override layer.

- [ ] **Step 1: Write the failing geometry contract test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const referenceCss = readFileSync(new URL('../styles/reference-fidelity.css', import.meta.url), 'utf8');

describe('1448×1086 reference geometry contract', () => {
  it('defines canonical measured reference tokens', () => {
    expect(tokens).toContain('--yv-ref-topbar-height: 76px');
    expect(tokens).toContain('--yv-ref-footer-height: 66px');
    expect(tokens).toContain('--yv-ref-rail-width: 304px');
    expect(tokens).toContain('--yv-ref-player-gutter: 16px');
  });

  it('loads the reference override after the existing style layers', () => {
    expect(main).toContain("import './styles/reference-fidelity.css';");
    expect(main.indexOf("./styles/reference-fidelity.css")).toBeGreaterThan(main.indexOf("./app/app.css"));
  });

  it('uses the canonical variables at desktop reference width', () => {
    expect(referenceCss).toContain('@media (min-width: 1400px)');
    expect(referenceCss).toContain('var(--yv-ref-rail-width)');
    expect(referenceCss).toContain('var(--yv-ref-footer-height)');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/app/referenceFidelity.test.ts`

Expected: FAIL because `reference-fidelity.css` and the new tokens/import do not exist yet.

- [ ] **Step 3: Add canonical tokens and the isolated override stylesheet**

Append to `:root` in `src/styles/tokens.css`:

```css
--yv-ref-topbar-height: 76px;
--yv-ref-footer-height: 66px;
--yv-ref-rail-width: 304px;
--yv-ref-player-gutter: 16px;
--yv-ref-track-label-width: 116px;
```

Create `src/styles/reference-fidelity.css` with the desktop shell baseline:

```css
@media (min-width: 1400px) {
  .studio-pro-shell.reference-fidelity {
    height: 100vh;
    min-height: 760px;
    overflow: hidden;
    display: grid;
    grid-template-rows: var(--yv-ref-topbar-height) minmax(0, 1fr) var(--yv-ref-footer-height);
  }

  .studio-pro-shell.reference-fidelity .topbar {
    height: var(--yv-ref-topbar-height);
    min-height: var(--yv-ref-topbar-height);
  }

  .studio-pro-shell.reference-fidelity .studio-grid {
    grid-template-columns: var(--yv-ref-rail-width) minmax(0, 1fr) var(--yv-ref-rail-width);
    min-height: 0;
  }

  .studio-pro-shell.reference-fidelity .center-stage {
    min-width: 0;
    min-height: 0;
  }

  .studio-pro-shell.reference-fidelity .studio-capability-strip {
    min-height: var(--yv-ref-footer-height);
  }
}
```

Add the last stylesheet import to `src/main.tsx`:

```ts
import './styles/reference-fidelity.css';
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/app/referenceFidelity.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/styles/tokens.css src/styles/reference-fidelity.css src/main.tsx src/app/referenceFidelity.test.ts
git commit -m "style: add YupVox reference geometry contract"
```

---

### Task 2: Reference-priority topbar without losing live status

**Files:**
- Modify: `src/app/StudioTopbar.tsx`
- Modify: `src/app/StudioTopbar.test.tsx`
- Modify: `src/styles/reference-fidelity.css`

**Interfaces:**
- Consumes: `SaveState`, `CloudState`, `cloudProgress`, `cloudDetail`, existing callbacks.
- Produces: the same `StudioTopbar` prop API; reference markup classes `.brand-wave`, `.reference-project-name`, `.reference-cloud-status`, `.reference-export-button` while status remains truthful.

- [ ] **Step 1: Add RED assertions for reference hierarchy and preserved status**

Add a test case that renders `StudioTopbar` with `saveState="saved"`, `cloudState="processing"`, `cloudProgress={0.42}` and asserts:

```ts
expect(screen.getByText('YupVox.Com')).toBeTruthy();
expect(screen.getByText('AI Studio Dubbing')).toBeTruthy();
expect(screen.getByText('Dự án:')).toBeTruthy();
expect(screen.getByText(/Processing/)).toBeTruthy();
expect(screen.getByText(/42%/)).toBeTruthy();
expect(screen.getByRole('button', { name: /Xuất bản Dubbing/i })).toBeDisabled();
```

Also assert the waveform mark is decorative and the existing mobile source/inspector buttons remain available by accessible label.

- [ ] **Step 2: Run focused topbar tests and verify RED**

Run: `npx vitest run src/app/StudioTopbar.test.tsx`

Expected: FAIL on `YupVox.Com`, `AI Studio Dubbing`, `Dự án:`, and `Xuất bản Dubbing` copy/classes.

- [ ] **Step 3: Rework topbar markup while keeping all operational props**

Replace the generic `Y` tile with:

```tsx
<div className="brand-wave" aria-hidden="true">
  <i /><i /><i /><i /><i /><i /><i />
</div>
<div className="brand-copy">
  <strong>YupVox.Com</strong>
  <span>AI Studio Dubbing</span>
</div>
```

Render project identity as:

```tsx
<div className="project-title reference-project-name">
  <span>Dự án:</span>
  <strong>{projectTitle}</strong>
  <IconButton label="Đổi tên dự án" icon="✎" />
</div>
```

Keep the save/cloud states inside a compact `.reference-cloud-status` block. When processing, keep the real `cloudStatusDetail` including percentage. Preserve undo/redo/command controls, but place them in `.reference-secondary-actions` so CSS may compact them at 1448px without removing their accessible buttons.

Keep credits/profile display and rename the disabled export control to `Xuất bản Dubbing` with its existing truthful capability tooltip.

- [ ] **Step 4: Add reference topbar CSS**

In `reference-fidelity.css`, at desktop width:

```css
.reference-fidelity .studio-topbar {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 0 20px;
  background: #0a0a0e;
  border-bottom: 1px solid #1c1b22;
}

.reference-fidelity .brand { min-width: 240px; }
.reference-fidelity .brand-wave { width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; gap: 2px; }
.reference-fidelity .brand-wave i { width: 3px; border-radius: 4px; background: linear-gradient(#dd59ff, #8738ef); }
.reference-fidelity .brand-wave i:nth-child(1),
.reference-fidelity .brand-wave i:nth-child(7) { height: 10px; }
.reference-fidelity .brand-wave i:nth-child(2),
.reference-fidelity .brand-wave i:nth-child(6) { height: 21px; }
.reference-fidelity .brand-wave i:nth-child(3),
.reference-fidelity .brand-wave i:nth-child(5) { height: 31px; }
.reference-fidelity .brand-wave i:nth-child(4) { height: 38px; }
.reference-fidelity .reference-project-name { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.reference-fidelity .studio-topbar-actions { margin-left: auto; gap: 10px; }
.reference-fidelity .reference-secondary-actions { display: flex; align-items: center; }
```

Hide only redundant status *detail text* at the exact reference width if necessary; never remove the state from accessible markup.

- [ ] **Step 5: Run topbar tests and full app test**

Run: `npx vitest run src/app/StudioTopbar.test.tsx src/app/App.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/StudioTopbar.tsx src/app/StudioTopbar.test.tsx src/styles/reference-fidelity.css
git commit -m "style: reconcile YupVox reference topbar"
```

---

### Task 3: Left rail ordering, dense upload/speakers, and live dubbing CTA

**Files:**
- Modify: `src/features/upload/UploadPanel.tsx`
- Create or modify: `src/features/upload/UploadPanel.test.tsx`
- Modify: `src/features/speakers/SpeakerList.tsx`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/styles/reference-fidelity.css`

**Interfaces:**
- Consumes: current `runCloudUploadFlow`, `onProcessStarted`, `SpeakerList`, `CloudProject['sourceLanguage']`.
- Produces: `UploadPanelProps` gains optional `speakerSection?: React.ReactNode`; all live upload behavior remains owned by `UploadPanel` and `StudioShell` only moves the visual speaker section into the reference order.

- [ ] **Step 1: Write RED DOM-order and live-action tests**

Create/extend `UploadPanel.test.tsx` to render:

```tsx
<UploadPanel speakerSection={<div data-testid="speaker-section">Nhân vật đã nhận diện</div>} />
```

Assert DOM order using `compareDocumentPosition`:

```ts
const drop = screen.getByText(/Kéo & thả file video/i);
const speakers = screen.getByTestId('speaker-section');
const sourceLanguage = screen.getByLabelText('Ngôn ngữ gốc');
expect(drop.compareDocumentPosition(speakers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(speakers.compareDocumentPosition(sourceLanguage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(screen.getByRole('button', { name: 'Bắt đầu Dubbing AI' })).toBeDisabled();
```

Keep or add the existing upload-flow mock assertion proving a selected valid file still calls `runCloudUploadFlow` and `onProcessStarted`.

- [ ] **Step 2: Run focused upload test and verify RED**

Run: `npx vitest run src/features/upload/UploadPanel.test.tsx`

Expected: FAIL because `speakerSection` and the required order do not exist.

- [ ] **Step 3: Add the presentation slot without moving upload state out of the component**

Update props:

```ts
import type { ReactNode } from 'react';

export type UploadPanelProps = {
  onProcessStarted?: (result: CloudUploadFlowResult) => void;
  speakerSection?: ReactNode;
};
```

Render order inside the component:

```tsx
<Panel title="Tải lên video">…drop zone / progress / status…</Panel>
{speakerSection}
<Panel title="Ngôn ngữ">…source/target selects…<button …>Bắt đầu Dubbing AI</button>…</Panel>
```

In `StudioShell`, replace separate `UploadPanel` and `SpeakerList` siblings with:

```tsx
<UploadPanel
  onProcessStarted={onProcessStarted}
  speakerSection={<SpeakerList speakers={state.project.speakers} selectedSpeakerId={selectedSpeaker?.id} />}
/>
```

- [ ] **Step 4: Restore dense reference classes in upload and speaker markup**

Add stable classes/hooks only, without fake behavior:

```tsx
<label className="upload-dropzone reference-drop-zone">…</label>
<div className="reference-upload-status">…real status/progress…</div>
```

Keep speaker waveform decoration as `aria-hidden` and retain actual speaker data.

- [ ] **Step 5: Add left-rail CSS**

Use the reference rail density:

```css
.reference-fidelity .left-rail { padding: 17px 16px 16px; overflow: auto; }
.reference-fidelity .reference-drop-zone { min-height: 145px; border-radius: 9px; background: #111116; }
.reference-fidelity .speaker-list { gap: 5px; }
.reference-fidelity .speaker-card { min-height: 58px; border-radius: 7px; }
.reference-fidelity .left-rail select { min-height: 39px; }
.reference-fidelity .left-rail .primary-button { min-height: 42px; }
```

- [ ] **Step 6: Run upload/shell tests**

Run: `npx vitest run src/features/upload/UploadPanel.test.tsx src/app/StudioShell.test.tsx src/app/App.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/upload/UploadPanel.tsx src/features/upload/UploadPanel.test.tsx src/features/speakers/SpeakerList.tsx src/app/StudioShell.tsx src/styles/reference-fidelity.css
git commit -m "style: restore reference left rail hierarchy"
```

---

### Task 4: Dense reference inspector with preserved persistence and compare flow

**Files:**
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Modify: `src/features/transcript/ScriptInspector.test.tsx`
- Modify: `src/styles/reference-fidelity.css`

**Interfaces:**
- Consumes: existing `onCommitPatch`, `onRetranslate`, `onApplyTranslation`, `translationMode`, `comparison`, `busy`, `error`.
- Produces: same callback behavior plus reference presentation hooks `.reference-inspector-header`, `.reference-script-card`, `.reference-translation-tools`, `.reference-voice-assignment`.

- [ ] **Step 1: Add RED reference inspector assertions**

Extend the existing cloud-editable inspector test to assert:

```ts
expect(screen.getByText('Kịch bản')).toBeTruthy();
expect(screen.getByLabelText('Lời thoại gốc')).toBeTruthy();
expect(screen.getByLabelText('Lời thoại dubbing tiếng Việt')).toBeTruthy();
expect(screen.getByRole('combobox', { name: 'Nhà cung cấp dịch' })).toBeTruthy();
expect(screen.getByRole('button', { name: 'Dịch lại' })).toBeTruthy();
expect(screen.getByText('Gán giọng cho nhân vật')).toBeTruthy();
expect(screen.getByText('Đồng bộ khẩu hình')).toBeTruthy();
```

Also assert compare mode still renders two explicit `Áp dụng` buttons and clicking one calls `onApplyTranslation` with only the selected text.

- [ ] **Step 2: Run inspector tests and verify RED only for new reference hooks/copy if necessary**

Run: `npx vitest run src/features/transcript/ScriptInspector.test.tsx`

Expected: current behavioral assertions may pass; add a class-level query such as `container.querySelector('.reference-script-card')` so the initial run is RED before styling markup is added.

- [ ] **Step 3: Add reference presentation classes without changing callbacks**

Update markup classes, for example:

```tsx
<div className="inspector-title reference-inspector-header">…</div>
<div className="language-card language-card--source reference-script-card">…</div>
<div className="language-card language-card--target reference-script-card">…</div>
<div className="translation-controls reference-translation-tools">…</div>
<div className="voice-section reference-voice-assignment">…</div>
```

Do not change the existing `onBlur` persistence, provider select, compare/apply calls, speaker mutation, or lip-sync reducer dispatch.

- [ ] **Step 4: Add dense 304px inspector CSS**

```css
.reference-fidelity .script-inspector { width: var(--yv-ref-rail-width); padding: 17px 14px; overflow: auto; }
.reference-fidelity .reference-script-card { border-radius: 8px; padding: 12px 11px 10px; }
.reference-fidelity .reference-script-card textarea { min-height: 46px; font-size: 10px; line-height: 1.5; }
.reference-fidelity .reference-translation-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
.reference-fidelity .reference-voice-assignment select { min-height: 44px; }
```

Keep visible focus styling from the existing design system.

- [ ] **Step 5: Run inspector/editor persistence tests**

Run: `npx vitest run src/features/transcript/ScriptInspector.test.tsx src/features/transcript/editorPersistence.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/transcript/ScriptInspector.tsx src/features/transcript/ScriptInspector.test.tsx src/styles/reference-fidelity.css
git commit -m "style: reconcile reference dubbing inspector"
```

---

### Task 5: Reference-frame the real player and dense V2.2 timeline

**Files:**
- Modify: `src/features/player/VideoStage.tsx` only if stable reference hooks are missing
- Modify: `src/features/player/VideoStage.test.tsx`
- Modify: `src/features/player/player.css`
- Modify: `src/features/timeline/Timeline.test.tsx`
- Modify: `src/features/timeline/timeline.css`
- Modify: `src/styles/reference-fidelity.css`

**Interfaces:**
- Consumes: current `VideoStage` playback props, media route, `Timeline` playback/timeline state and dispatch.
- Produces: no new data-flow API; presentation hooks/classes only.

- [ ] **Step 1: Add RED presentation hooks while retaining interaction tests**

In `VideoStage.test.tsx`, assert the real `<video>` path still renders for a cloud project and add:

```ts
expect(container.querySelector('.reference-video-frame')).toBeTruthy();
expect(container.querySelector('.reference-transport-row')).toBeTruthy();
```

In `Timeline.test.tsx`, preserve zoom/seek/drag assertions and add:

```ts
expect(container.querySelector('.reference-timeline')).toBeTruthy();
expect(container.querySelector('.reference-playhead')).toBeTruthy();
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/features/player/VideoStage.test.tsx src/features/timeline/Timeline.test.tsx`

Expected: FAIL only on new presentation hooks; existing behavior remains green.

- [ ] **Step 3: Add stable reference classes to existing live elements**

Add classes to the already-functional player/timeline nodes instead of changing event handlers or state logic. The real `<video>` and its range-backed source stay unchanged.

- [ ] **Step 4: Apply reference framing in CSS**

At desktop reference width:

```css
.reference-fidelity .video-stage { padding: 14px var(--yv-ref-player-gutter) 0; }
.reference-fidelity .reference-video-frame { border-radius: 8px 8px 0 0; background: #050507; overflow: hidden; }
.reference-fidelity .reference-transport-row { min-height: 55px; }
.reference-fidelity .reference-timeline { margin: 0 var(--yv-ref-player-gutter) 14px; }
.reference-fidelity .timeline-ruler { grid-template-columns: var(--yv-ref-track-label-width) 1fr; min-height: 29px; }
.reference-fidelity .timeline-row { grid-template-columns: var(--yv-ref-track-label-width) minmax(0, 1fr); min-height: 45px; }
```

Keep the current playhead/zoom/scroll dimensions required by pointer math; if a visual height change affects interaction math, update the shared CSS variable rather than duplicating constants.

- [ ] **Step 5: Run player/timeline behavior suites**

Run: `npx vitest run src/features/player/VideoStage.test.tsx src/features/player/playback.test.ts src/features/timeline/Timeline.test.tsx src/features/timeline/math.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/player/VideoStage.tsx src/features/player/VideoStage.test.tsx src/features/player/player.css src/features/timeline/Timeline.test.tsx src/features/timeline/timeline.css src/styles/reference-fidelity.css
git commit -m "style: reference-frame player and timeline"
```

---

### Task 6: Restore the 66px reference capability footer truthfully

**Files:**
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`
- Modify: `src/styles/reference-fidelity.css`

**Interfaces:**
- Consumes: no new backend capabilities.
- Produces: five reference capability items; unavailable voice/lip-sync/export claims remain explicitly guarded.

- [ ] **Step 1: Add RED footer content test**

Render `StudioShell` with the existing mock state and assert these visible concepts:

```ts
expect(screen.getByText('Dub mọi ngôn ngữ')).toBeTruthy();
expect(screen.getByText('Tự nhận diện nhân vật')).toBeTruthy();
expect(screen.getByText(/Voice preservation/i)).toBeTruthy();
expect(screen.getByText('Chạy trên Cloud 24/7')).toBeTruthy();
expect(screen.getByText(/AI voices/i)).toBeTruthy();
```

Assert the voice-related items include guarded copy such as `Capability-gated` rather than a live-success claim.

- [ ] **Step 2: Run shell test and verify RED**

Run: `npx vitest run src/app/StudioShell.test.tsx`

Expected: FAIL because the current compact capability strip uses different content.

- [ ] **Step 3: Replace only footer presentation markup**

Use five compact items, for example:

```tsx
<footer className="capability-strip studio-capability-strip reference-feature-strip" aria-label="Năng lực hệ thống">
  <div><span aria-hidden="true">◎</span><span><strong>Dub mọi ngôn ngữ</strong><small>Workers AI + Google optional</small></span></div>
  <div><span aria-hidden="true">◉</span><span><strong>Tự nhận diện nhân vật</strong><small>Whisper + persisted segments</small></span></div>
  <div title="Capability-gated"><span aria-hidden="true">≋</span><span><strong>Voice preservation</strong><small>Capability-gated</small></span></div>
  <div><span aria-hidden="true">☁</span><span><strong>Chạy trên Cloud 24/7</strong><small>Workflow + R2 + D1</small></span></div>
  <div title="Capability-gated"><span aria-hidden="true">◍</span><span><strong>AI voices</strong><small>Capability-gated</small></span></div>
</footer>
```

- [ ] **Step 4: Style the 66px reference footer and preserve mobile collapse**

```css
@media (min-width: 1400px) {
  .reference-fidelity .reference-feature-strip {
    height: var(--yv-ref-footer-height);
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    align-items: center;
    padding: 0 28px;
    border-top: 1px solid #1c1b22;
    background: #0a0a0e;
  }
  .reference-fidelity .reference-feature-strip > div { display: flex; align-items: center; justify-content: center; gap: 10px; }
  .reference-fidelity .reference-feature-strip strong,
  .reference-fidelity .reference-feature-strip small { display: block; }
}
```

Do not override the existing mobile rule that hides/collapses the footer below the desktop breakpoint.

- [ ] **Step 5: Run shell/accessibility tests**

Run: `npx vitest run src/app/StudioShell.test.tsx src/app/App.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/StudioShell.tsx src/app/StudioShell.test.tsx src/styles/reference-fidelity.css
git commit -m "style: restore truthful reference capability footer"
```

---

### Task 7: Activate reference mode, full regression, browser screenshot, PR cleanup, merge

**Files:**
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/referenceFidelity.test.ts`
- Modify: `docs/deployment-status.md` only if the current UI qualification status is documented there

**Interfaces:**
- Consumes: all previous tasks.
- Produces: `<div className="app-shell studio-pro-shell reference-fidelity …">`, final 1448×1086 screenshot evidence, exact-head GREEN PR, merged `main`.

- [ ] **Step 1: Add RED activation assertion**

In `referenceFidelity.test.ts`, render or source-check `StudioShell` and require the shell class:

```ts
expect(studioShellSource).toContain('studio-pro-shell reference-fidelity');
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `npx vitest run src/app/referenceFidelity.test.ts`

Expected: FAIL until `reference-fidelity` is activated on the shell.

- [ ] **Step 3: Activate reference mode**

Update the shell root:

```tsx
<div className={`app-shell studio-pro-shell reference-fidelity mobile-panel--${mobilePanel}`}>
```

No state/data flow changes in this step.

- [ ] **Step 4: Run the full verification suite**

Run: `npm run verify`

Expected: exit `0`; deploy-config tests, Vitest suite, TypeScript build, and Vite production build all pass.

- [ ] **Step 5: Run Wrangler dry-run**

Run: `npx wrangler deploy --dry-run`

Expected: exit `0`, with current Worker/Workflow/Container bindings accepted without production mutation.

- [ ] **Step 6: Create a fresh local screenshot from the exact GitHub head**

Use the public repository in a clean temporary directory:

```bash
rm -rf /tmp/dubflow-reference-check
git clone https://github.com/trinhtanphat/dubflow.git /tmp/dubflow-reference-check
cd /tmp/dubflow-reference-check
git checkout <EXACT_FEATURE_HEAD_SHA>
npm install --no-audit --no-fund
npm run build
npm run dev -- --host 127.0.0.1 > /tmp/dubflow-vite.log 2>&1 &
VITE_PID=$!
sleep 3
chromium --headless --disable-gpu --no-sandbox --window-size=1448,1086 --screenshot=/tmp/yupvox-v2-2-reference.png http://127.0.0.1:5173/
kill "$VITE_PID"
```

Inspect `/tmp/yupvox-v2-2-reference.png` against the supplied 1448×1086 reference. Specifically verify topbar/footer heights, 304px rails, player bounds, timeline density, inspector density, typography scale, purple intensity, and excess chrome.

- [ ] **Step 7: Make only measured visual corrections and re-run verification**

If screenshot review finds a mismatch, change only the responsible CSS/markup, then repeat:

```bash
npm run verify
npx wrangler deploy --dry-run
```

and regenerate the screenshot. Do not call the result `100% pixel-perfect` unless a real image-diff metric is added and meets an explicit threshold.

- [ ] **Step 8: Commit final activation/qualification changes**

```bash
git add src/app/StudioShell.tsx src/app/referenceFidelity.test.ts src/styles/reference-fidelity.css docs/deployment-status.md
git commit -m "style: qualify YupVox V2.2 reference fidelity"
```

Only include `docs/deployment-status.md` if it was actually changed.

- [ ] **Step 9: Re-check live `main` before PR**

Compare exact branch head with current `main`. If `main` advanced, reconcile non-force and run fresh `npm run verify` + Wrangler dry-run on the reconciled head before opening/merging the PR.

- [ ] **Step 10: Open the reference-fidelity PR and require exact-head CI GREEN**

PR body must list:

- preserved V2.2/pipeline invariants;
- 1448×1086 geometry targets;
- RED→GREEN evidence per task;
- exact-head `npm run verify` and Wrangler dry-run evidence;
- screenshot qualification statement that avoids unsupported pixel-perfect claims;
- production deploy remains manual-only pending Container credential qualification.

- [ ] **Step 11: Close stale PR #2 only after its visual intent is represented in the new PR**

Update PR #2 body/state to `closed`, explaining that its visual foundation has been reconciled into the current Studio Pro V2.2 carrier and that its old composition must not be merged.

- [ ] **Step 12: Merge exact-head GREEN PR into `main` and verify the merge commit**

Merge only with `expected_head_sha=<exact green head>`. Then run/fetch post-merge `main` CI and require `npm run verify` + Wrangler dry-run GREEN on the merge commit before calling source completion.

- [ ] **Step 13: Report truthful completion boundary**

Report source/UI reconciliation and CI status separately from production runtime deployment. Production Container runtime remains unqualified until the Cloudflare token has Containers Write/Edit and a real media fixture passes end-to-end.
