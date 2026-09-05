# Studio Pro V2 Completion Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining implementation gaps against the already-approved YupVox Studio Pro V2 acceptance criteria without inventing a V2.6 scope, then qualify the exact head through CI and keep production fail-closed until Cloudflare Container credentials are valid.

**Architecture:** Preserve the current cloud/editor architecture and add only missing Studio V2 interaction surfaces. Command handling becomes a small reusable action registry consumed by keyboard shortcuts and a command palette; the inspector becomes four explicit tabs while reusing existing translation/voice capability services; visual lip-sync remains unavailable unless a real backend capability says otherwise.

**Tech Stack:** React 19, TypeScript, Vitest, Hono/Cloudflare Workers, D1, R2, Cloudflare Workflows/Containers, Vite, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-05-yupvox-studio-pro-v2-design.md`

## Global Constraints

- Work from exact base `75b46bf957249b46cdc1f4efb913ae694692e6fb` unless `main` advances, in which case reconcile non-force before final qualification.
- Do not weaken V2.5 optimistic concurrency, autosave conflict handling, export invalidation, project busy locking, or revision-aware undo/redo.
- Do not fake provider success or visual lip-sync capability.
- Keep `yupvox.qs3d.site` as the canonical production hostname.
- GitHub Actions exact-head CI remains the authoritative source/build gate.
- Production deployment remains manual-only and runtime remains UNQUALIFIED until a token with Cloudflare Containers Write/Edit is available and a real media fixture passes.
- Follow TDD: RED first, minimal GREEN, then refactor.

---

### Task 1: Add the missing command model and command palette

**Files:**
- Create: `src/app/studioCommands.ts`
- Create: `src/app/studioCommands.test.ts`
- Create: `src/components/CommandPalette/CommandPalette.tsx`
- Create: `src/components/CommandPalette/CommandPalette.test.tsx`
- Modify: `src/components/ui.css`

**Interfaces:**
- Produces: `StudioCommand` with `{ id, label, shortcut?, disabled?, run }`.
- Produces: `buildStudioCommands(input): StudioCommand[]`.
- Produces: `<CommandPalette open commands onClose />`.

- [ ] **Step 1: Write failing command-registry tests**

```ts
it('exposes split, undo, redo, zoom and panel commands without running disabled commands', () => {
  const calls: string[] = [];
  const commands = buildStudioCommands({
    canSplit: true,
    canUndo: false,
    canRedo: true,
    split: () => calls.push('split'),
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    zoomIn: () => calls.push('zoom-in'),
    zoomOut: () => calls.push('zoom-out'),
    openSources: () => calls.push('sources'),
    openInspector: () => calls.push('inspector'),
  });
  expect(commands.map((command) => command.id)).toContain('split-segment');
  expect(commands.find((command) => command.id === 'undo')?.disabled).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/app/studioCommands.test.ts`
Expected: FAIL because `studioCommands.ts` does not exist.

- [ ] **Step 3: Implement the minimal typed command registry**

```ts
export type StudioCommand = {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run(): void;
};
```

Include commands for split, undo, redo, zoom in/out, open sources, and open inspector. Keep execution callbacks injected; do not import editor state into this module.

- [ ] **Step 4: Write palette component tests**

Cover open/closed rendering, keyboard Escape close, text filtering, disabled-command behavior, and clicking an enabled command calls `run()` then `onClose()`.

- [ ] **Step 5: Implement `CommandPalette` minimally**

Use a dialog-like overlay with `role="dialog"`, an autofocus search input, keyboard Escape handling, and buttons for filtered commands. No external command-menu dependency.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/app/studioCommands.test.ts src/components/CommandPalette/CommandPalette.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/studioCommands.ts src/app/studioCommands.test.ts src/components/CommandPalette src/components/ui.css
git commit -m "feat: add Studio command palette"
```

### Task 2: Wire complete V2 keyboard shortcuts through one action boundary

**Files:**
- Create: `src/app/shortcuts.ts`
- Create: `src/app/shortcuts.test.ts`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`
- Modify: `src/app/StudioTopbar.test.tsx`

**Interfaces:**
- Consumes: `StudioCommand[]` from Task 1.
- Produces: `resolveStudioShortcut(event, context): StudioShortcutAction | null`.

- [ ] **Step 1: Write failing shortcut tests**

Cover:
- `Ctrl/Cmd+K` => open command palette.
- `Ctrl/Cmd+Z` => undo; `Ctrl/Cmd+Shift+Z` => redo.
- `S` => split selected segment at playhead.
- `+` / `-` => timeline zoom when the timeline owns focus.
- `Escape` => close palette/mobile panels.
- Typing inside input/textarea/select/contenteditable suppresses editor shortcuts except native text undo behavior.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/app/shortcuts.test.ts src/app/StudioShell.test.tsx`
Expected: FAIL because the centralized shortcut resolver and palette wiring are absent.

- [ ] **Step 3: Implement `shortcuts.ts` as pure logic**

```ts
export type StudioShortcutAction =
  | 'open-commands'
  | 'undo'
  | 'redo'
  | 'split'
  | 'zoom-in'
  | 'zoom-out'
  | 'escape';
```

The resolver must not mutate state; it only returns an action or `null`.

- [ ] **Step 4: Wire `StudioShell`**

Add `commandPaletteOpen` state, create the command list from existing editor callbacks, replace `onOpenCommands={() => {}}`, and route keyboard events through `resolveStudioShortcut`. Preserve mutation locks and cloud-editable checks before executing editor mutations.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run src/app/shortcuts.test.ts src/app/StudioShell.test.tsx src/app/StudioTopbar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/shortcuts.ts src/app/shortcuts.test.ts src/app/StudioShell.tsx src/app/StudioShell.test.tsx src/app/StudioTopbar.test.tsx
git commit -m "feat: wire Studio keyboard commands"
```

### Task 3: Complete the four-tab inspector contract

**Files:**
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Modify: `src/features/transcript/ScriptInspector.test.tsx`
- Modify: `src/features/transcript/ScriptInspectorAutosave.test.tsx`
- Modify: `src/app/app.css`

**Interfaces:**
- Expand `InspectorTab` to `'script' | 'characters' | 'voice' | 'ai'`.
- Preserve existing autosave draft callbacks and `SegmentConflictNotice` behavior unchanged.
- Preserve existing `fetchVoiceCapabilities`, `createVoicePreviewAction`, translation compare/apply callbacks, and per-speaker voice resolution.

- [ ] **Step 1: Write failing tab-contract tests**

Assert four tab buttons are present: `Kịch bản`, `Nhân vật`, `Giọng nói`, `AI`. Switching tabs must expose only the relevant pane while preserving the selected segment and draft text.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/transcript/ScriptInspector.test.tsx`
Expected: FAIL because only Script and Characters tabs exist.

- [ ] **Step 3: Split current content by responsibility**

- Script: source text, translated text, draft error/conflict state.
- Characters: selected speaker identity and segment speaker assignment.
- Voice: provider capability, assigned speaker voice, preview/regenerate controls.
- AI: Workers AI / Google / Compare selector, retranslate action, provider comparison and explicit apply.

Do not duplicate provider calls across tabs; reuse the existing capability state already loaded by the component.

- [ ] **Step 4: Preserve autosave/conflict regression behavior**

Run: `npx vitest run src/features/transcript/ScriptInspectorAutosave.test.tsx src/features/transcript/SegmentConflictNotice.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run inspector suite**

Run: `npx vitest run src/features/transcript/ScriptInspector.test.tsx src/features/transcript/ScriptInspectorAutosave.test.tsx src/features/transcript/speakerVoiceSelection.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/transcript/ScriptInspector.tsx src/features/transcript/ScriptInspector.test.tsx src/features/transcript/ScriptInspectorAutosave.test.tsx src/app/app.css
git commit -m "feat: complete Studio inspector tabs"
```

### Task 4: Make visual lip-sync truthfully capability-gated and finish reduced-motion accessibility

**Files:**
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Modify: `src/features/transcript/ScriptInspector.test.tsx`
- Modify: `src/app/app.css`
- Modify: `src/styles/reference-fidelity.css`

**Interfaces:**
- Add optional `visualLipSyncAvailable?: boolean` prop defaulting to `false`.
- Existing `lipSyncEnabled` state remains a preference but cannot be toggled on when visual capability is unavailable.

- [ ] **Step 1: Write failing capability test**

```tsx
render(<ScriptInspector {...props} visualLipSyncAvailable={false} />);
expect(screen.getByRole('button', { name: /đồng bộ khẩu hình/i })).toBeDisabled();
expect(screen.getByText(/visual lip-sync chưa khả dụng/i)).toBeInTheDocument();
```

Also test `visualLipSyncAvailable={true}` permits the existing toggle dispatch.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/transcript/ScriptInspector.test.tsx`
Expected: FAIL because the current toggle is always active.

- [ ] **Step 3: Implement fail-closed visual lip-sync control**

Keep duration fitting copy separate from visual lip-sync. Default to unavailable until a verified backend capability is explicitly supplied.

- [ ] **Step 4: Add reduced-motion CSS**

Add a single `@media (prefers-reduced-motion: reduce)` block that disables non-essential transitions/animations in the Studio shell, timeline, toggles, tooltips, palette, and fidelity layer while preserving layout/state changes.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run src/features/transcript/ScriptInspector.test.tsx src/app/StudioShell.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/transcript/ScriptInspector.tsx src/features/transcript/ScriptInspector.test.tsx src/app/app.css src/styles/reference-fidelity.css
git commit -m "fix: gate visual lip sync capability"
```

### Task 5: Add a V2 acceptance regression gate and qualify exact head

**Files:**
- Create: `tests/studio-v2-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `docs/deployment-status.md` only for source status; do not claim runtime PASS.

**Interfaces:**
- Acceptance gate checks source contracts that can be proven in CI.
- Runtime-only requirements remain explicitly UNQUALIFIED until deployed real-fixture evidence exists.

- [ ] **Step 1: Write the acceptance gate**

The test must assert source-level evidence for:
- real player surface exists;
- timeline selection/move/resize/split tests exist;
- revision-aware undo/redo + autosave/conflict modules exist;
- translation modes Workers AI / Google / Compare are reachable;
- four inspector tabs exist;
- command palette callback is not a no-op;
- visual lip-sync defaults fail-closed;
- CI workflow still runs verify/build/Wrangler dry-run;
- canonical domain remains `yupvox.qs3d.site`.

- [ ] **Step 2: Run RED/GREEN acceptance test**

Run: `node --test tests/studio-v2-acceptance.test.mjs`
Expected before Tasks 1–4: FAIL on known gaps. Expected after Tasks 1–4: PASS.

- [ ] **Step 3: Run the full repository gate**

Run:
```bash
npm run verify
npx wrangler deploy --dry-run
```
Expected: all tests PASS, TypeScript/Vite build PASS, Wrangler dry-run PASS.

- [ ] **Step 4: Push branch and open PR against current `main`**

Before opening/merging, compare exact branch head against current `main`. If `main` advanced, reconcile non-force and rerun the full gate.

- [ ] **Step 5: Exact-head CI**

Use the PR exact head only. Require verify/build, Wrangler dry-run, 1448×1086 screenshot, and artifact upload to all PASS.

- [ ] **Step 6: Merge only after exact-head GREEN and review**

Use a normal merge commit; no force update of `main`.

- [ ] **Step 7: Post-merge qualification**

Require the push CI on the resulting `main` merge SHA to be GREEN before declaring the Studio Pro V2 source complete.

- [ ] **Step 8: Keep production fail-closed**

Do not dispatch production repeatedly while the documented Cloudflare Container credential remains unauthorized. After the token is externally corrected with Containers Write/Edit, run the manual production workflow and require `/api/ready` plus a real media fixture for diarization/export before changing runtime from UNQUALIFIED to PASS.
