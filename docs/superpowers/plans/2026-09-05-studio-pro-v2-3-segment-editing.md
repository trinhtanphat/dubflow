# YupVox Studio Pro V2.3 Segment Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct segment move/resize/split editing with deterministic snapping, bounded undo/redo, and durable Worker-backed timing persistence.

**Architecture:** Keep all timing/snap/split math in pure timeline-domain modules; keep pointer preview transient; commit only validated semantic mutations into reducer history; route durable writes through one frontend mutation service and strengthen the Worker repository with current-state overlap checks plus atomic split/restore operations. Playback, selection, zoom and scroll remain outside undo history.

**Tech Stack:** React 19, TypeScript, Vitest, Hono, Cloudflare Workers, D1, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-05-studio-pro-v2-3-segment-editing-design.md`

## Global Constraints

- Minimum segment duration: exactly 100 ms.
- Snap screen threshold: exactly 8 px.
- Grid snap interval: exactly 100 ms.
- Snap tie priority: neighbor boundary, then playhead, then grid.
- History capacity: exactly 100 committed operations.
- Pointer preview must never write to D1 or create history entries.
- One drag/resize gesture creates at most one committed history entry.
- Split is valid only when both children are at least 100 ms.
- Newly split right-side IDs are generated on the Worker, never trusted from the client.
- Split/restore must use atomic D1 batch support; fail closed when batch is unavailable.
- Timing changes invalidate affected segment voice state back to `pending`.
- V2.5 revision tokens/autosave conflict handling remain out of scope.
- Exact PR head must pass full tests, TypeScript/Vite build and Wrangler dry-run before merge.

---

### Task 1: Pure timing, snapping and text-split domain

**Files:**
- Create: `src/features/timeline/editing.ts`
- Create: `src/features/timeline/editing.test.ts`
- Modify: `src/features/timeline/math.ts`

**Interfaces:**
- Produces:
  - `type SegmentTiming = { startMs: number; endMs: number }`
  - `type TimingNeighbors = { previousEndMs: number; nextStartMs: number }`
  - `clampMoveTiming(current, deltaMs, neighbors, durationMs): SegmentTiming`
  - `clampResizeTiming(current, edge, targetMs, neighbors, durationMs): SegmentTiming`
  - `snapEdgeTime(targetMs, candidates, pixelsPerSecond): number`
  - `splitTextAtRatio(text, ratio): { left: string; right: string }`
  - `splitSegmentDraft(segment, playheadMs): { left; right }`

- [ ] **Step 1: Write failing pure tests**

Cover duration-preserving move, project/neighbor clamp, left/right resize, minimum 100 ms, snap threshold/tie priority, valid/invalid split, whitespace split, and no-whitespace Unicode split. Example core assertion:

```ts
expect(clampMoveTiming(
  { startMs: 1000, endMs: 2000 },
  700,
  { previousEndMs: 0, nextStartMs: 2400 },
  5000,
)).toEqual({ startMs: 1400, endMs: 2400 });
```

- [ ] **Step 2: Run focused test and verify RED**

Run: `npx vitest run src/features/timeline/editing.test.ts`
Expected: FAIL because `editing.ts` does not exist.

- [ ] **Step 3: Implement minimal pure domain**

Use one exported constant `MIN_SEGMENT_MS = 100`. Convert the 8 px threshold into milliseconds using the active zoom. For snapping, rank candidates by absolute pixel distance then priority, reject candidates outside 8 px, and re-clamp after applying the chosen snap. `splitTextAtRatio` must work on `Array.from(text)` so Unicode code points are not split mid-surrogate.

- [ ] **Step 4: Run focused tests GREEN**

Run: `npx vitest run src/features/timeline/editing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/timeline/editing.ts src/features/timeline/editing.test.ts src/features/timeline/math.ts
git commit -m "feat: add segment timing edit domain"
```

### Task 2: Bounded editor history and transient preview state

**Files:**
- Create: `src/app/editorHistory.ts`
- Create: `src/app/editorHistory.test.ts`
- Modify: `src/app/studioState.ts`
- Modify: `src/app/studioState.test.ts`

**Interfaces:**
- Produces:
  - `type TimingMutation = { kind: 'timing'; segmentId: string; before: Segment; after: Segment }`
  - `type SplitMutation = { kind: 'split'; originalBefore: Segment; leftAfter: Segment; rightAfter: Segment }`
  - `type EditorMutation = TimingMutation | SplitMutation`
  - `type EditorHistory = { past: EditorMutation[]; future: EditorMutation[] }`
  - reducer actions for `previewSegmentTiming`, `cancelSegmentPreview`, `commitTimingMutation`, `commitSplitMutation`, `applyUndoLocal`, `applyRedoLocal`.

- [ ] **Step 1: Write history RED tests**

Assert 100-entry cap, redo clear on new mutation, timing undo/redo, split undo/redo, and that playback/selection/zoom actions do not change history length.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/app/editorHistory.test.ts src/app/studioState.test.ts`
Expected: FAIL because history/preview do not exist.

- [ ] **Step 3: Implement minimal history helpers and reducer state**

Add:

```ts
history: { past: [], future: [] },
segmentPreview: null as null | { segmentId: string; startMs: number; endMs: number },
```

Use immutable snapshots. `commitTimingMutation` and `commitSplitMutation` update project segments and push exactly one entry. `applyUndoLocal`/`applyRedoLocal` modify local project + history only; network persistence remains outside the reducer.

- [ ] **Step 4: Run focused tests GREEN**

Run: `npx vitest run src/app/editorHistory.test.ts src/app/studioState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/editorHistory.ts src/app/editorHistory.test.ts src/app/studioState.ts src/app/studioState.test.ts
git commit -m "feat: add bounded segment edit history"
```

### Task 3: Direct-manipulation timeline UI

**Files:**
- Modify: `src/features/timeline/SegmentBlock.tsx`
- Modify: `src/features/timeline/TimelineTrack.tsx`
- Modify: `src/features/timeline/Timeline.tsx`
- Modify: `src/features/timeline/timeline.css`
- Create/Modify tests: `src/features/timeline/SegmentBlock.test.tsx`, `src/features/timeline/Timeline.test.tsx`

**Interfaces:**
- Consumes Task 1 timing helpers and Task 2 preview/reducer actions.
- Produces semantic callbacks:

```ts
type SegmentEditIntent =
  | { kind: 'move'; segmentId: string; startMs: number; endMs: number }
  | { kind: 'resize'; segmentId: string; edge: 'left' | 'right'; startMs: number; endMs: number };
```

`Timeline` accepts `onCommitSegmentEdit(intent): void` and `onSplitSelected(): void` from the shell.

- [ ] **Step 1: Write component RED tests**

Test that selected block exposes body/left/right manipulation controls, pointer move emits preview only, pointer-up emits one commit, Escape cancels preview, and target/source blocks share one segment ID selection.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/timeline/SegmentBlock.test.tsx src/features/timeline/Timeline.test.tsx`
Expected: FAIL because manipulation handles/callbacks are absent.

- [ ] **Step 3: Implement pointer lifecycle**

`SegmentBlock` uses pointer capture and only emits semantic drag lifecycle events. `Timeline` converts pointer delta into milliseconds, computes legal/snap-adjusted timing with Task 1 helpers, dispatches preview during movement and delegates only pointer-up commit. Escape dispatches `cancelSegmentPreview`.

- [ ] **Step 4: Add keyboard split guard test and implementation**

`S` invokes split only when the selected segment contains the playhead and focus is not `input`, `textarea`, `select`, or contenteditable. Do not steal native text undo.

- [ ] **Step 5: Run focused tests GREEN**

Run: `npx vitest run src/features/timeline/SegmentBlock.test.tsx src/features/timeline/Timeline.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/timeline
git commit -m "feat: add direct segment manipulation"
```

### Task 4: Strengthen Worker timing validation and add atomic split/restore

**Files:**
- Create: `migrations/0003_segment_split_lineage.sql`
- Modify: `worker/src/domain/segment.ts`
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/src/routes/segments.ts`
- Modify: `worker/test/segments.test.ts`
- Create: `worker/test/segment-split.test.ts`

**Interfaces:**
- Add Worker repository methods:

```ts
updateSegment(projectId, segmentId, userId, patch): Promise<Segment | null>
splitSegment(projectId, segmentId, userId, playheadMs): Promise<{ left: Segment; right: Segment }>
restoreSplit(projectId, segmentId, childSegmentId, userId, original: SegmentRestoreInput): Promise<Segment>
```

- Add routes:
  - `POST /api/projects/:id/segments/:segmentId/split` body `{ playheadMs }`
  - `POST /api/projects/:id/segments/:segmentId/restore-split` body `{ childSegmentId, original }`

- [ ] **Step 1: Write Worker RED tests**

Tests must prove legal timing PATCH succeeds, overlap PATCH fails, split generates right ID server-side, invalid split leaves rows unchanged, restore removes only a child whose `split_parent_id` matches the original, and non-owner/cross-project mutation fails closed.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run worker/test/segments.test.ts worker/test/segment-split.test.ts`
Expected: FAIL because overlap/split behavior is absent.

- [ ] **Step 3: Add lineage migration**

```sql
ALTER TABLE segments ADD COLUMN split_parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_segments_project_split_parent
ON segments(project_id, split_parent_id);
```

- [ ] **Step 4: Implement current-state validation**

Before timing writes, list authorized project segments, sort by `startMs/id`, derive previous/next bounds, reject `<100 ms`, overlap, negative start, or end past project duration. Fetch project duration through the authorized project row. Return stable error codes such as `SEGMENT_OVERLAP`, `SEGMENT_TOO_SHORT`, `INVALID_SPLIT_POINT`.

- [ ] **Step 5: Implement atomic split**

Use `crypto.randomUUID()` inside the Worker/repository for the child ID. Require `db.batch`; batch one UPDATE of the original left row and one INSERT of the right row with `split_parent_id = original.id`. Split source/translated text with the same deterministic Task-1 algorithm ported into Worker domain or a shared pure module. Set `voice_status='pending'` on both affected rows.

- [ ] **Step 6: Implement narrow atomic restore**

Before batching, verify the child belongs to the same project/user and has `split_parent_id === original.id`. Batch DELETE child + UPDATE original from validated restore payload. Do not expose arbitrary delete.

- [ ] **Step 7: Run Worker tests GREEN**

Run: `npx vitest run worker/test/segments.test.ts worker/test/segment-split.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add migrations/0003_segment_split_lineage.sql worker/src worker/test
git commit -m "feat: persist atomic segment timing edits"
```

### Task 5: Frontend mutation service, rollback, undo/redo persistence

**Files:**
- Modify: `src/features/transcript/segmentApi.ts`
- Create: `src/features/timeline/segmentMutationService.ts`
- Create: `src/features/timeline/segmentMutationService.test.ts`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioTopbar.tsx` only if callback/disabled-state typing requires it

**Interfaces:**
- API functions:

```ts
splitSegment(projectId, segmentId, playheadMs): Promise<{ left: CloudSegment; right: CloudSegment }>
restoreSplit(projectId, segmentId, childSegmentId, original): Promise<CloudSegment>
```

- Service functions:

```ts
commitSegmentTiming(projectId, segmentId, timing): Promise<CloudSegment>
commitSegmentSplit(projectId, segmentId, playheadMs): Promise<SplitResult>
persistUndo(projectId, mutation): Promise<CanonicalMutationResult>
persistRedo(projectId, mutation): Promise<CanonicalMutationResult>
```

- [ ] **Step 1: Write service RED tests**

Assert timing calls PATCH once, split calls dedicated endpoint once, timing undo persists `before`, redo persists `after`, split undo calls restore-split, and failed persistence does not report success.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/features/timeline/segmentMutationService.test.ts`
Expected: FAIL because service/API functions are absent.

- [ ] **Step 3: Implement API/service**

Keep networking out of Timeline components. Normalize Worker responses to existing `StudioProject['segments'][number]` shape before dispatch.

- [ ] **Step 4: Wire StudioShell commit flow**

For move/resize: persist first, then dispatch one canonical `commitTimingMutation`; on failure dispatch `cancelSegmentPreview`, show `editorError`, then `restoreCloudProject()`.

For split: persist first, then dispatch `commitSplitMutation` with canonical left/right rows.

For undo/redo: apply local history action immediately, persist inverse/forward operation, and if persistence fails, apply the opposite local history action to restore the previous confirmed state while keeping the action retryable.

Wire topbar `canUndo/canRedo` and callbacks from real history lengths.

- [ ] **Step 5: Add shell integration tests**

Test successful timing commit, split, undo/redo callbacks, and rollback path after a rejected persistence promise.

- [ ] **Step 6: Run focused tests GREEN**

Run: `npx vitest run src/features/timeline/segmentMutationService.test.ts src/app/StudioShell.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/transcript/segmentApi.ts src/features/timeline/segmentMutationService.ts src/features/timeline/segmentMutationService.test.ts src/app/StudioShell.tsx src/app/StudioShell.test.tsx src/app/StudioTopbar.tsx
git commit -m "feat: wire durable segment editing"
```

### Task 6: Full regression, review and integration gate

**Files:**
- Modify only files required by failures found by authoritative verification.

- [ ] **Step 1: Run complete test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: TypeScript and Vite build PASS.

- [ ] **Step 3: Run deploy verification**

Run: `npm run verify`
Expected: source/deploy-config tests + test + build PASS.

- [ ] **Step 4: Run Wrangler dry-run**

Run: `npx wrangler deploy --dry-run`
Expected: PASS and FFmpeg container build remains valid.

- [ ] **Step 5: Review PR diff**

Check specifically: no pointer preview network calls; no history for playback/view actions; overlap validation is server-side; split child IDs are Worker-generated; restore cannot delete unrelated segments; voice state is invalidated after timing/split; no V2.5 revision/autosave scope creep.

- [ ] **Step 6: Reconcile current `main` if it advanced**

Use a non-force merge/reconciliation. Re-run exact-head CI after reconciliation. Do not merge based on stale CI.

- [ ] **Step 7: Merge only exact-head GREEN**

Mark PR ready, re-check `mergeable_state=clean`, merge with `expected_head_sha`, then verify merged `main` CI.
