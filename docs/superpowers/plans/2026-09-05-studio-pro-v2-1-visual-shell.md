# YupVox Studio Pro V2.1 Visual Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing YupVox shell into a premium, responsive studio layout with reusable UI primitives, visible save/cloud states, and accessibility-safe interactions without changing timeline editing semantics yet.

**Architecture:** Keep `App.tsx` composition-only by introducing a `StudioShell` and small primitives under `src/components`. Split the monolithic `src/app/app.css` into token/global/layout files plus feature-scoped CSS while preserving current feature behavior. V2.1 only changes presentation and shell-level UI state; video/timeline interaction work starts in V2.2.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7, Vitest 3, CSS custom properties, Cloudflare Workers Static Assets.

**Spec:** `docs/superpowers/specs/2026-09-05-yupvox-studio-pro-v2-design.md`

## Global Constraints

- Production target remains `https://yupvox.qs3d.site`.
- Existing 5 GB / 3 hour media limits remain unchanged.
- GitHub Actions CI remains the authoritative dependency/test/typecheck/Vite/Wrangler dry-run gate.
- Do not claim voice cloning, production visual lip-sync, or final media export unless the configured backend capability explicitly supports it.
- Existing reducer behavior, upload API, translation providers, D1/R2 bindings, and Worker routes must remain backward compatible during V2.1.
- All icon-only controls require accessible labels and visible focus states.
- Respect `prefers-reduced-motion`.

---

### Task 1: Design token and stylesheet foundation

**Files:**
- Create: `src/styles/tokens.css`
- Create: `src/styles/globals.css`
- Create: `src/styles/layout.css`
- Modify: `src/main.tsx`
- Modify: `src/app/app.css`
- Test: `src/app/App.test.tsx`

**Interfaces:**
- Consumes: existing class names from `App.tsx` and feature components.
- Produces: CSS variables `--yv-bg-canvas`, `--yv-bg-panel`, `--yv-bg-elevated`, `--yv-border`, `--yv-text`, `--yv-text-muted`, `--yv-accent`, `--yv-success`, `--yv-danger`, `--yv-focus`, spacing/radius/elevation tokens used by later V2.1 tasks.

- [ ] **Step 1: Write the failing shell-style import test**

Add an assertion to `src/app/App.test.tsx` that renders the app and expects the root shell to expose the V2 class hook:

```tsx
expect(markup).toContain('studio-pro-shell');
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run src/app/App.test.tsx
```

Expected: FAIL because `studio-pro-shell` is not present.

- [ ] **Step 3: Add token/global/layout styles and import them before legacy compatibility CSS**

`src/styles/tokens.css` must define at minimum:

```css
:root {
  color-scheme: dark;
  --yv-bg-canvas: #08090d;
  --yv-bg-panel: #0f1117;
  --yv-bg-elevated: #151821;
  --yv-border: #262a36;
  --yv-border-strong: #353a49;
  --yv-text: #f7f7fb;
  --yv-text-muted: #9297a8;
  --yv-accent: #9655ff;
  --yv-accent-strong: #7d35f2;
  --yv-success: #38d58a;
  --yv-warning: #f5b95f;
  --yv-danger: #ff6674;
  --yv-focus: 0 0 0 3px rgba(150, 85, 255, .28);
  --yv-radius-sm: 8px;
  --yv-radius-md: 12px;
  --yv-radius-lg: 16px;
  --yv-space-1: 4px;
  --yv-space-2: 8px;
  --yv-space-3: 12px;
  --yv-space-4: 16px;
  --yv-space-5: 20px;
  --yv-space-6: 24px;
  --yv-shadow-panel: 0 18px 60px rgba(0, 0, 0, .28);
}
```

`src/styles/globals.css` must include the reset, typography, focus-visible rule and reduced-motion rule:

```css
*:focus-visible { outline: none; box-shadow: var(--yv-focus); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

Update `src/main.tsx` imports in this order:

```ts
import './styles/tokens.css';
import './styles/globals.css';
import './styles/layout.css';
import './app/app.css';
```

Keep `app.css` temporarily as compatibility CSS; remove root token definitions duplicated by `tokens.css`.

- [ ] **Step 4: Add `studio-pro-shell` to the app root and rerun the focused test**

Change the root from:

```tsx
<div className="app-shell">
```

to:

```tsx
<div className="app-shell studio-pro-shell">
```

Run:

```bash
npx vitest run src/app/App.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run typecheck/build and commit**

```bash
npm run build
git add src/styles src/main.tsx src/app/App.tsx src/app/App.test.tsx src/app/app.css
git commit -m "feat(ui): add Studio Pro design token foundation"
```

Expected: `tsc -b` and `vite build` PASS.

---

### Task 2: Reusable status and icon primitives

**Files:**
- Create: `src/components/StatusBadge/StatusBadge.tsx`
- Create: `src/components/StatusBadge/StatusBadge.test.tsx`
- Create: `src/components/IconButton/IconButton.tsx`
- Create: `src/components/IconButton/IconButton.test.tsx`
- Create: `src/components/Tooltip/Tooltip.tsx`
- Create: `src/components/ui.css`
- Modify: `src/main.tsx`

**Interfaces:**
- Produces:

```ts
export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
export function StatusBadge(props: { label: string; tone?: StatusTone; detail?: string }): JSX.Element;
export function IconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: React.ReactNode }): JSX.Element;
export function Tooltip(props: { text: string; children: React.ReactNode }): JSX.Element;
```

- [ ] **Step 1: Write failing component tests**

`StatusBadge.test.tsx`:

```tsx
const html = renderToStaticMarkup(<StatusBadge label="Saved" tone="success" detail="Cloud synced" />);
expect(html).toContain('Saved');
expect(html).toContain('Cloud synced');
expect(html).toContain('status-badge--success');
```

`IconButton.test.tsx`:

```tsx
const html = renderToStaticMarkup(<IconButton label="Undo" icon="↶" />);
expect(html).toContain('aria-label="Undo"');
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
npx vitest run src/components/StatusBadge/StatusBadge.test.tsx src/components/IconButton/IconButton.test.tsx
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement minimal primitives**

`StatusBadge.tsx`:

```tsx
export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export function StatusBadge({ label, tone = 'neutral', detail }: { label: string; tone?: StatusTone; detail?: string }) {
  return <span className={`status-badge status-badge--${tone}`}><i aria-hidden="true" /><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span></span>;
}
```

`IconButton.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function IconButton({ label, icon, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode }) {
  return <button {...props} aria-label={label} title={label} className={`ui-icon-button ${className}`.trim()}>{icon}</button>;
}
```

`Tooltip.tsx` keeps native semantics and avoids a portal in V2.1:

```tsx
import type { ReactNode } from 'react';
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return <span className="ui-tooltip" data-tooltip={text}>{children}</span>;
}
```

- [ ] **Step 4: Add primitive CSS and rerun tests**

Import `src/components/ui.css` from `src/main.tsx` and style focus, hover, status tone and tooltip surfaces without hard-coded feature-specific layout.

Run:

```bash
npx vitest run src/components/StatusBadge/StatusBadge.test.tsx src/components/IconButton/IconButton.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components src/main.tsx
git commit -m "feat(ui): add reusable Studio Pro status primitives"
```

---

### Task 3: Studio top bar and shell composition

**Files:**
- Create: `src/app/StudioShell.tsx`
- Create: `src/app/StudioTopbar.tsx`
- Create: `src/app/StudioTopbar.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/styles/layout.css`
- Modify: `src/app/app.css`

**Interfaces:**
- Consumes existing `state.project.title`, `selectedSegment`, `selectedSpeaker`, `dispatch`.
- Produces shell-only types:

```ts
export type SaveState = 'saved' | 'saving' | 'offline' | 'retrying' | 'error';
export type CloudState = 'ready' | 'processing' | 'degraded';
```

`StudioTopbar` props:

```ts
{
  projectTitle: string;
  saveState: SaveState;
  cloudState: CloudState;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onOpenCommands(): void;
}
```

V2.1 uses `saveState="saved"`, `cloudState="ready"`, and disabled undo/redo until V2.3 history exists.

- [ ] **Step 1: Write failing top-bar test**

```tsx
const html = renderToStaticMarkup(<StudioTopbar projectTitle="Tập 01" saveState="saved" cloudState="ready" canUndo={false} canRedo={false} onUndo={() => {}} onRedo={() => {}} onOpenCommands={() => {}} />);
expect(html).toContain('Saved');
expect(html).toContain('Cloud ready');
expect(html).toContain('aria-label="Mở bảng lệnh"');
```

- [ ] **Step 2: Run focused test and confirm RED**

```bash
npx vitest run src/app/StudioTopbar.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement top bar with truthful status primitives**

Map states exactly:

```ts
const saveCopy = {
  saved: ['Saved', 'success'],
  saving: ['Saving…', 'accent'],
  offline: ['Offline', 'warning'],
  retrying: ['Retrying', 'warning'],
  error: ['Save failed', 'danger'],
} as const;
```

Cloud copy:

```ts
const cloudCopy = {
  ready: ['Cloud ready', 'success'],
  processing: ['Processing', 'accent'],
  degraded: ['Cloud degraded', 'warning'],
} as const;
```

Use `IconButton` for Undo, Redo and Command Palette. Keep export disabled unless an actual export capability is passed later.

- [ ] **Step 4: Introduce `StudioShell` and simplify `App.tsx`**

`App.tsx` should become:

```tsx
export function App() {
  const studio = useStudioState();
  return <StudioShell {...studio} />;
}
```

`StudioShell` owns top-bar/left-center-right composition but not feature internals.

- [ ] **Step 5: Run tests/build and commit**

```bash
npx vitest run src/app/App.test.tsx src/app/StudioTopbar.test.tsx
npm run build
git add src/app src/styles src/components
git commit -m "feat(ui): refine Studio Pro shell and top bar"
```

Expected: PASS.

---

### Task 4: Responsive rails and inspector presentation

**Files:**
- Modify: `src/styles/layout.css`
- Modify: `src/app/app.css`
- Modify: `src/features/upload/UploadPanel.tsx`
- Modify: `src/features/speakers/SpeakerList.tsx`
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Test: `src/app/App.test.tsx`

**Interfaces:**
- No backend/API changes.
- Preserve existing feature props and reducer actions.

- [ ] **Step 1: Extend the app render test with semantic region expectations**

```tsx
expect(markup).toContain('aria-label="Nguồn media và nhân vật"');
expect(markup).toContain('aria-label="Không gian chỉnh sửa"');
expect(markup).toContain('aria-label="Inspector dubbing"');
```

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/app/App.test.tsx
```

Expected: FAIL because labels are not yet present.

- [ ] **Step 3: Add semantic labels and compact professional panel headers**

Left rail:

```tsx
<aside className="left-rail" aria-label="Nguồn media và nhân vật">...</aside>
```

Center:

```tsx
<section className="center-stage" aria-label="Không gian chỉnh sửa">...</section>
```

Inspector:

```tsx
<aside className="script-inspector" aria-label="Inspector dubbing">...</aside>
```

Remove demo-copy such as `Phase 2` from visible primary actions where the feature is not being activated in V2.1; replace with truthful capability copy such as `Chưa cấu hình` or disabled tooltip text.

- [ ] **Step 4: Implement breakpoints exactly**

In `layout.css`:

```css
.studio-grid { grid-template-columns: minmax(248px, 288px) minmax(0, 1fr) minmax(300px, 340px); }
@media (max-width: 1279px) {
  .studio-grid { grid-template-columns: 232px minmax(0, 1fr) 286px; }
  .topbar-copy-secondary { display: none; }
}
@media (max-width: 899px) {
  .studio-grid { grid-template-columns: 1fr; }
  .left-rail, .script-inspector { position: fixed; inset-block: 64px 0; width: min(88vw, 360px); z-index: 50; transform: translateX(-105%); }
  .script-inspector { right: 0; left: auto; transform: translateX(105%); }
  .center-stage { min-width: 0; }
}
```

Do not add open/close drawer behavior yet; at small width hidden rails remain non-blocking until the shell toggle behavior is added in Task 5.

- [ ] **Step 5: Rerun test/build and commit**

```bash
npx vitest run src/app/App.test.tsx
npm run build
git add src/styles src/features src/app
git commit -m "feat(ui): make Studio Pro workspace responsive and semantic"
```

---

### Task 5: Mobile panel toggles, polished capability strip, and V2.1 regression gate

**Files:**
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioTopbar.tsx`
- Modify: `src/styles/layout.css`
- Modify: `src/app/App.test.tsx`
- Create: `src/app/StudioShell.test.tsx`

**Interfaces:**
- `StudioShell` local UI-only state:

```ts
type MobilePanel = 'none' | 'sources' | 'inspector';
```

No reducer change is required because panel visibility is transient UI state.

- [ ] **Step 1: Write failing shell toggle test**

Render `StudioShell` and verify controls exist:

```tsx
expect(html).toContain('aria-label="Mở nguồn media"');
expect(html).toContain('aria-label="Mở inspector"');
```

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/app/StudioShell.test.tsx
```

- [ ] **Step 3: Implement mobile panel controls**

Use local state:

```tsx
const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
```

Apply class hooks:

```tsx
<div className={`app-shell studio-pro-shell mobile-panel--${mobilePanel}`}>
```

Buttons set `sources`, `inspector`, or toggle back to `none`. CSS at `<900px` maps these classes to `transform: translateX(0)` for the active rail. At desktop widths the controls are visually hidden but remain out of the tab order with CSS/display rules.

- [ ] **Step 4: Replace the footer capability strip with compact truthful states**

Keep only capabilities already implemented/configured in source:

```text
Workers AI translation
Google Translation optional
R2 multipart media
D1 project state
Voice provider capability-aware
```

Do not describe unavailable voice cloning or media export as active.

- [ ] **Step 5: Run the full authoritative pre-PR gate**

```bash
npm run verify
npx wrangler deploy --dry-run
```

Expected:
- Node deployment tests PASS.
- Vitest PASS.
- `tsc -b` PASS.
- Vite production build PASS.
- Wrangler dry-run PASS.

- [ ] **Step 6: Commit**

```bash
git add src

git commit -m "feat(ui): complete Studio Pro V2.1 visual shell"
```

- [ ] **Step 7: Open PR and wait for exact-head GitHub Actions GREEN before merge**

PR title:

```text
feat: YupVox Studio Pro V2.1 visual shell
```

Merge only when CI for the exact PR head is GREEN. After merge, allow the existing production deploy workflow to run from `main` and verify `https://yupvox.qs3d.site/api/ready` before calling the release deployed.
