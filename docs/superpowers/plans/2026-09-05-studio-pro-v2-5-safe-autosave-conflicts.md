# YupVox Studio Pro V2.5 Safe Autosave & Conflict Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcript text/speaker/timing editing revision-aware, autosaved, conflict-safe, and truthfully represented in the YupVox Studio UI without silently overwriting newer D1 state.

**Architecture:** Keep `segments.version` as the canonical per-segment optimistic-concurrency token. D1 compare-and-swap is the correctness boundary; the frontend keeps canonical segments separate from unsaved draft patches, uses a focused autosave coordinator for 600 ms debounce/serialization, and commits history only after canonical Worker responses. Existing V2.3 timing/split history, V2.2 reference-fidelity UI, and the newly merged ElevenLabs voice-preview controls must remain intact.

**Tech Stack:** React 19, TypeScript, Vitest, Hono, Cloudflare Workers, D1, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-05-studio-pro-v2-5-safe-autosave-conflicts-design.md`

## Global Constraints

- Reuse the existing `segments.version`; do not add a project-wide revision lock.
- Every editor-driven single-segment write must carry the canonical version it is based on.
- A stale write must return `409 SEGMENT_VERSION_CONFLICT`; it must never overwrite the newer row.
- Source/translated text autosave delay is exactly **600 ms** of inactivity.
- Blur flushes a dirty text draft immediately.
- A selected-segment change flushes the previous selected segment's dirty text draft.
- Only one write per segment may be in flight at once; edits arriving during a save remain dirty for a subsequent pass.
- Speaker assignment persists immediately through the same revision protocol.
- Conflict policy is exactly **A — safe reapply**: `Dùng bản mới trên server` or `Áp dụng lại thay đổi của tôi`.
- Save-state priority is `conflict > error > saving > dirty > saved`.
- A successful autosave burst creates one history entry; a failed save creates none.
- Existing editor history remains capped at exactly **100** committed operations.
- Native text-field Ctrl/Cmd+Z must remain native while typing.
- Split/restore remain atomic D1 operations and gain version preconditions.
- Timing changes continue to invalidate affected voice state to `pending`.
- Voice preview/ElevenLabs capability detection is read-only from V2.5's perspective and must not regress.
- Production Cloudflare Container credential qualification is out of scope for V2.5.
- Exact PR head must pass full `npm run verify`, Wrangler dry-run, and 1448×1086 screenshot CI before merge; if `main` moves, reconcile non-force and requalify.

---

### Task 1: Carry canonical segment versions through Studio and expose typed conflict payloads

**Files:**
- Modify: `src/features/timeline/types.ts`
- Modify: `src/app/cloudStudio.ts`
- Modify: `src/app/cloudStudio.test.ts`
- Modify: `src/lib/api/client.ts`
- Modify: `src/lib/api/client.test.ts`
- Modify: `src/features/transcript/segmentApi.ts`
- Modify: `src/features/transcript/segmentApi.test.ts`

**Interfaces:**
- Produces `Segment.version: number` on every canonical Studio segment.
- Extends `ApiError` with `payload: unknown` so feature APIs can inspect structured error bodies without duplicating fetch logic.
- Changes `patchSegment(projectId, segmentId, expectedVersion, patch)`.
- Adds `SegmentVersionConflictError` carrying `canonical: CloudSegment`.

- [ ] **Step 1: Write failing version-plumbing tests**

Add assertions equivalent to:

```ts
expect(buildCloudStudioProject(project, [{ ...cloudSegment, version: 7 }]).segments[0]?.version).toBe(7);

await expect(patchSegment('p1', 's1', 7, { translatedText: 'Xin chào' }, fetchImpl))
  .rejects.toMatchObject({
    name: 'SegmentVersionConflictError',
    canonical: { id: 's1', version: 8, translatedText: 'Bản mới' },
  });
```

Update the API-client error test so a JSON body such as `{ code: 'X', message: 'bad', segment: { id: 's1' } }` remains available on `ApiError.payload`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run src/app/cloudStudio.test.ts src/lib/api/client.test.ts src/features/transcript/segmentApi.test.ts
```

Expected: FAIL because Studio `Segment` drops `version`, `ApiError` drops the payload, and `patchSegment` still sends the legacy bare patch body.

- [ ] **Step 3: Implement minimal canonical version plumbing**

Use these contracts:

```ts
export type Segment = {
  id: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
  version: number;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly payload: unknown = undefined,
  ) { super(message); this.name = 'ApiError'; }
}

export class SegmentVersionConflictError extends Error {
  readonly code = 'SEGMENT_VERSION_CONFLICT';
  constructor(public readonly canonical: CloudSegment) {
    super('Segment changed on the server.');
    this.name = 'SegmentVersionConflictError';
  }
}
```

`apiFetch` passes the parsed JSON body into `ApiError`. `patchSegment` sends:

```json
{ "expectedVersion": 7, "patch": { "translatedText": "Xin chào" } }
```

and converts only a well-formed `409 SEGMENT_VERSION_CONFLICT` payload into `SegmentVersionConflictError`; malformed conflicts fail closed as the original `ApiError`.

- [ ] **Step 4: Run focused tests GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/timeline/types.ts src/app/cloudStudio.ts src/app/cloudStudio.test.ts src/lib/api/client.ts src/lib/api/client.test.ts src/features/transcript/segmentApi.ts src/features/transcript/segmentApi.test.ts
git commit -m "feat: carry segment revision tokens"
```

### Task 2: Enforce D1 compare-and-swap for PATCH writes

**Files:**
- Modify: `worker/src/db/projects.ts`
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/src/domain/segment.ts`
- Modify: `worker/src/routes/segments.ts`
- Modify: `worker/test/segments.test.ts`
- Create: `worker/test/segment-version-conflict.test.ts`

**Interfaces:**
- `D1StatementLike.run()` returns `{ meta?: { changes?: number } }` and `D1DatabaseLike.batch()` returns those results.
- `updateSegment(projectId, segmentId, userId, expectedVersion, patch)` performs SQL CAS.
- `SegmentPersistenceError` may carry `current?: Segment` for `SEGMENT_VERSION_CONFLICT`.

- [ ] **Step 1: Write Worker CAS RED tests**

Cover matching version, stale version, ownership, malformed envelope, and timing overlap remaining distinct. The mock SQL assertion must prove the write itself contains `AND version = ?`.

Core stale assertion:

```ts
await expect(repo.updateSegment('p1', 's1', 'u1', 4, { translatedText: 'stale' }))
  .rejects.toMatchObject({ code: 'SEGMENT_VERSION_CONFLICT', current: { version: 5 } });
```

Route assertion:

```ts
expect(response.status).toBe(409);
expect(await response.json()).toMatchObject({
  code: 'SEGMENT_VERSION_CONFLICT',
  segment: { id: 's1', version: 5 },
});
```

- [ ] **Step 2: Run Worker tests RED**

```bash
npx vitest run worker/test/segments.test.ts worker/test/segment-version-conflict.test.ts
```

Expected: FAIL because PATCH is still pre-read + unconditional UPDATE and accepts a bare patch body.

- [ ] **Step 3: Implement the request envelope and CAS boundary**

Validate `expectedVersion` as a positive integer and `patch` as the existing normalized patch object. The UPDATE must include the version predicate:

```sql
UPDATE segments
SET source_text = ?, translated_text = ?, speaker_id = ?, start_ms = ?, end_ms = ?,
    voice_status = ?, version = version + 1
WHERE id = ? AND project_id = ? AND version = ?
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.user_id = ?)
```

After `run()`, require `meta.changes === 1`. If zero, re-read the authorized segment: return not-found when absent; otherwise throw `SEGMENT_VERSION_CONFLICT` with that canonical row. Do not predict the new version; re-read or return a row whose values/version are derived from the confirmed write result.

- [ ] **Step 4: Run Worker tests GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db/projects.ts worker/src/db/segments.ts worker/src/domain/segment.ts worker/src/routes/segments.ts worker/test/segments.test.ts worker/test/segment-version-conflict.test.ts
git commit -m "feat: enforce segment compare and swap"
```

### Task 3: Make timing, split/restore, and retranslation version-aware

**Files:**
- Modify: `src/features/transcript/segmentApi.ts`
- Modify: `src/features/translation/translationApi.ts`
- Modify: `src/features/transcript/editorPersistence.ts`
- Modify: `src/features/timeline/segmentMutationService.ts`
- Modify: corresponding frontend tests
- Modify: `worker/src/db/segments.ts`
- Modify: `worker/src/routes/segments.ts`
- Modify: `worker/src/routes/translation.ts`
- Modify: corresponding Worker tests

**Interfaces:**
- `splitSegment(projectId, segmentId, expectedVersion, playheadMs)`.
- `restoreSplit(projectId, segmentId, expectedVersion, childSegmentId, expectedChildVersion, original)`.
- `retranslateSegment(projectId, segmentId, expectedVersion, mode)`.
- Timing writes use `before.version` automatically.
- Persisted translation providers use CAS after inference; compare mode never mutates D1.

- [ ] **Step 1: Write stale structural/translation RED tests**

Prove a stale timing write, stale split, stale restore, and stale persisted retranslation all reject with `SEGMENT_VERSION_CONFLICT`, while compare-mode translation makes no persistence call.

For split/restore mocks, assert both parent and child preconditions are represented in the request and repository operations.

- [ ] **Step 2: Run focused tests RED**

```bash
npx vitest run src/features/transcript/segmentApi.test.ts src/features/timeline/segmentMutationService.test.ts src/features/transcript/editorPersistence.test.ts worker/test/segment-split.test.ts worker/test/translation-router.test.ts
```

Expected: FAIL because these mutation paths do not yet carry versions.

- [ ] **Step 3: Implement version-aware structural writes without weakening atomicity**

For split, generate the right-side ID on the Worker and use an atomic batch whose first INSERT is conditional on the parent still having `expectedVersion`; the following parent UPDATE also requires that same version and the just-created child lineage. Inspect batch result `meta.changes` and require one insert + one update.

For restore, update the parent first only when both parent version and child `expectedChildVersion`/lineage match; set parent version to `expectedVersion + 1`. Delete the child second only when that new parent version and the child version/lineage still match. Require one update + one delete. This ordering makes a stale precondition produce zero changes rather than deleting/restoring half of the pair.

For persisted retranslation, the model/provider may run first, but the eventual D1 result write must use the request's `expectedVersion`; if the segment changed during inference, return revision conflict instead of overwriting it.

- [ ] **Step 4: Run focused tests GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/transcript src/features/translation src/features/timeline/segmentMutationService.ts worker/src/db/segments.ts worker/src/routes/segments.ts worker/src/routes/translation.ts worker/test
git commit -m "feat: make editor mutations revision aware"
```

### Task 4: Add draft state machine and field-mutation history

**Files:**
- Create: `src/app/autosaveDraft.ts`
- Create: `src/app/autosaveDraft.test.ts`
- Modify: `src/app/editorHistory.ts`
- Modify: `src/app/editorHistory.test.ts`
- Modify: `src/app/studioState.ts`
- Modify: `src/app/studioState.test.ts`

**Interfaces:**
- `SegmentFieldPatch = Partial<Pick<Segment, 'sourceText' | 'translatedText' | 'speakerId'>>`.
- `SegmentDraft` stores `base`, `patch`, `phase`, `editRevision`, optional `savingRevision`, `error`, and `conflictingServer`.
- `EditorMutation` gains `{ kind: 'fields'; segmentId; fields; before; after }`.
- Reducer actions include `editDraft`, `beginDraftSave`, `commitDraftSave`, `failDraftSave`, `conflictDraftSave`, `discardDraftForServer`, `rebaseDraftForSafeReapply`.

- [ ] **Step 1: Write reducer/domain RED tests**

Cover:

```text
clean -> dirty -> saving -> clean
saving + newer edit -> canonical success -> dirty residual patch
network failure -> error with patch preserved
version conflict -> conflict with patch + canonical server preserved
discard -> server canonical + no draft
safe reapply -> server becomes base + only touched local fields remain dirty
successful field save -> exactly one history entry
101 commits -> only newest 100 remain
hydrateProject -> unresolved dirty/conflict segment is not silently replaced
```

- [ ] **Step 2: Run focused RED tests**

```bash
npx vitest run src/app/autosaveDraft.test.ts src/app/editorHistory.test.ts src/app/studioState.test.ts
```

Expected: FAIL because drafts and field history do not exist.

- [ ] **Step 3: Implement immutable draft transitions**

Use a monotonic `editRevision` per draft. `beginDraftSave` records the submitted revision/patch. On canonical success, always replace the canonical project row with the Worker response. If the draft changed while saving, keep only field values that differ from the submitted patch, rebase them onto the returned canonical segment, and return to `dirty`; otherwise clear the draft.

`applyMutation` for a field history item replaces only the fields named by the mutation when deriving local undo/redo state. Do not include playback, selection, zoom, scroll, or pointer preview in history.

- [ ] **Step 4: Run focused tests GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/autosaveDraft.ts src/app/autosaveDraft.test.ts src/app/editorHistory.ts src/app/editorHistory.test.ts src/app/studioState.ts src/app/studioState.test.ts
git commit -m "feat: add revision aware autosave drafts"
```

### Task 5: Build the 600 ms autosave coordinator and unsaved-work guard

**Files:**
- Create: `src/app/segmentAutosaveCoordinator.ts`
- Create: `src/app/segmentAutosaveCoordinator.test.ts`
- Create: `src/app/useSegmentAutosave.ts`
- Create: `src/app/useSegmentAutosave.test.tsx`

**Interfaces:**
- `createSegmentAutosaveCoordinator({ delayMs: 600, readDraft, persist, onSaving, onSuccess, onError, onConflict })`.
- Returns `schedule(segmentId)`, `flush(segmentId)`, `retry(segmentId)`, `dispose()`.
- Hook exposes `edit(segmentId, patch)`, `flush(segmentId)`, `retry(segmentId)`, `discardConflict(segmentId)`, `reapplyConflict(segmentId)`.

- [ ] **Step 1: Write fake-timer RED tests**

Use `vi.useFakeTimers()` and prove:

```text
3 edits inside 600 ms -> 1 write after 600 ms
blur/flush -> write immediately
same segment -> never >1 request in flight
edit during request -> second request after first canonical response
network error -> no automatic loop, retryable state preserved
version conflict -> no automatic retry until explicit resolution
beforeunload listener only active while dirty/saving/error/conflict exists
```

- [ ] **Step 2: Run focused RED tests**

```bash
npx vitest run src/app/segmentAutosaveCoordinator.test.ts src/app/useSegmentAutosave.test.tsx
```

Expected: FAIL because coordinator/hook do not exist.

- [ ] **Step 3: Implement coordinator serialization**

Use one timer and one in-flight promise per segment ID. `flush()` clears the timer and starts persistence only when no request for that segment is active. If a new edit arrives during persistence, `schedule()` records pending work; after success it re-reads the reducer draft and schedules/flushes only if unresolved dirty work remains. Conflict stops scheduling for that segment until discard/reapply. `dispose()` clears timers but never fabricates a successful save.

The hook registers `beforeunload` only when reducer state contains unresolved `dirty | saving | error | conflict` drafts and removes it when clean/unmounted.

- [ ] **Step 4: Run focused tests GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/segmentAutosaveCoordinator.ts src/app/segmentAutosaveCoordinator.test.ts src/app/useSegmentAutosave.ts src/app/useSegmentAutosave.test.tsx
git commit -m "feat: coordinate safe transcript autosave"
```

### Task 6: Integrate truthful autosave/conflict UX without regressing voice preview

**Files:**
- Create: `src/features/transcript/SegmentConflictNotice.tsx`
- Create: `src/features/transcript/SegmentConflictNotice.test.tsx`
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Modify: `src/features/transcript/ScriptInspector.test.tsx`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`
- Modify: `src/app/StudioTopbar.tsx` only if its existing save-state union needs `dirty`/`conflict`
- Modify: `src/app/StudioTopbar.test.tsx` when the union changes

**Interfaces:**
- Inspector receives displayed draft values plus `onDraftEdit`, `onDraftBlur`, `onRetrySave`, conflict state/actions.
- Conflict notice renders exactly two resolution actions: `Dùng bản mới trên server` and `Áp dụng lại thay đổi của tôi`.
- Topbar status derives from all drafts using priority `conflict > error > saving > dirty > saved`.

- [ ] **Step 1: Write component RED tests**

Assert text `onChange` edits a draft instead of dispatching canonical `editSource/editTranslation`; blur flushes; speaker change edits + immediately flushes; conflict card exposes exactly the two policy-A actions; retry appears for non-conflict errors; save labels truthfully render `Đã lưu`, `Chưa lưu`, `Đang lưu…`, `Lỗi lưu`, `Xung đột`.

Also retain the existing voice assertions: Characters tab, capability detection, ElevenLabs label, preview buttons and fail-closed disabled state must still render.

- [ ] **Step 2: Run component tests RED**

```bash
npx vitest run src/features/transcript/SegmentConflictNotice.test.tsx src/features/transcript/ScriptInspector.test.tsx src/app/StudioShell.test.tsx src/app/StudioTopbar.test.tsx
```

Expected: FAIL on autosave/conflict behavior while the existing voice-preview tests remain the regression baseline.

- [ ] **Step 3: Wire the coordinator into StudioShell**

Replace `commitPatch`/direct canonical typing with the V2.5 hook. Keep canonical `state.project.segments` unchanged during keystrokes; derive the inspector's visible segment by applying the draft patch over the selected canonical segment. Track the previous selected segment ID in an effect and `flush(previousId)` when selection changes. Blur calls `flush(currentId)`. Speaker assignment calls `edit(...speakerId...)` then `flush()` immediately.

Do not alter `createVoicePreviewAction`, `fetchVoiceCapabilities`, Characters tab, or voice preview network paths except for type adaptations caused by `Segment.version`.

- [ ] **Step 4: Wire conflict and retry UI**

`SegmentConflictNotice` receives no network functions. Discard dispatches the reducer resolution action. Safe reapply rebases the touched patch onto `conflictingServer`, then invokes coordinator `flush()` with the new canonical version. A second stale response remains conflict; never force-write.

- [ ] **Step 5: Run component tests GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/transcript src/app/StudioShell.tsx src/app/StudioShell.test.tsx src/app/StudioTopbar.tsx src/app/StudioTopbar.test.tsx
git commit -m "feat: add truthful autosave conflict UX"
```

### Task 7: Make undo/redo use current canonical versions and reconcile every Worker response

**Files:**
- Modify: `src/features/timeline/segmentMutationService.ts`
- Modify: `src/features/timeline/segmentMutationService.test.ts`
- Modify: `src/app/StudioShell.tsx`
- Modify: `src/app/StudioShell.test.tsx`
- Modify: `src/app/editorHistory.ts`
- Modify: `src/app/studioState.ts`

**Interfaces:**
- `persistUndo(projectId, mutation, currentProject)` and `persistRedo(projectId, mutation, currentProject)` derive expected versions from the current canonical segment, never from a stale historical snapshot.
- All successful undo/redo paths return canonical Worker segments/mutations for reducer reconciliation.

- [ ] **Step 1: Write revision-aware history RED tests**

Prove field undo sends only the changed fields with the current canonical version; timing undo/redo uses current canonical version; split redo reconciles a fresh Worker child ID/version; version conflict rolls local optimistic history movement back and enters the same conflict state instead of displaying saved.

- [ ] **Step 2: Run focused tests RED**

```bash
npx vitest run src/features/timeline/segmentMutationService.test.ts src/app/editorHistory.test.ts src/app/studioState.test.ts src/app/StudioShell.test.tsx
```

Expected: FAIL because current V2.3 undo/redo persistence accepts historical mutation snapshots without current revision input.

- [ ] **Step 3: Implement current-version persistence and canonical reconciliation**

For a field mutation, compute the inverse/forward patch from `mutation.fields`, but use `currentSegment.version` as `expectedVersion`. For timing mutation, send current version with before/after timing. For split/restore, pass current parent/child versions. On success dispatch a canonical reconciliation action before considering the editor saved. On revision conflict, restore the local history pointer to its pre-command position and populate the V2.5 conflict draft from the Worker canonical row.

- [ ] **Step 4: Run focused tests GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/timeline/segmentMutationService.ts src/features/timeline/segmentMutationService.test.ts src/app/editorHistory.ts src/app/studioState.ts src/app/StudioShell.tsx src/app/StudioShell.test.tsx
git commit -m "feat: make editor history revision safe"
```

### Task 8: Full V2.5 qualification, live-main reconciliation, and PR merge gate

**Files:**
- Modify documentation only if source behavior or qualification status needs correction after implementation.
- Do not change the manual-only production deployment policy as part of V2.5.

**Interfaces:**
- Consumes all prior tasks.
- Produces an exact-head qualified PR suitable for merge to `main`.

- [ ] **Step 1: Run the full repository verification**

```bash
npm run verify
npx wrangler deploy --dry-run
```

Expected: both exit 0 with all existing and new tests passing.

- [ ] **Step 2: Audit the spec acceptance criteria line by line**

Verify each of the 11 acceptance criteria in the design spec against a focused test or source boundary. Specifically confirm stale-write CAS, 600 ms debounce, conflict draft preservation, both policy-A actions, field history, no false saved state, beforeunload guard, voice-preview regression coverage, and version-aware structural writes.

- [ ] **Step 3: Re-read live `main` before merge**

If `main` is no longer an ancestor of the feature head, merge current `main` into the feature branch **non-force**, resolve by preserving both sides' behavior, then rerun Step 1 on the new exact head. Never reuse an older CI run after reconciliation.

- [ ] **Step 4: Require fresh PR-triggered exact-head CI GREEN**

The exact feature head must pass source verification/build, Wrangler dry-run, and the 1448×1086 Chromium screenshot job. Keep the PR draft while any required check is RED/in-progress.

- [ ] **Step 5: Merge with expected-head protection and verify the merge SHA**

After the PR is mergeable and exact-head GREEN, mark ready and merge using the exact expected head SHA. Then require a fresh post-merge `main` CI run on the resulting merge commit to complete GREEN before calling V2.5 source-qualified.

- [ ] **Step 6: Preserve production-runtime boundary**

Do not call production runtime PASS from V2.5 CI. Cloudflare Container deployment remains separately blocked until the production API token is externally granted Account `Containers Edit/Write` and a real supported media fixture completes the deployed pipeline.
