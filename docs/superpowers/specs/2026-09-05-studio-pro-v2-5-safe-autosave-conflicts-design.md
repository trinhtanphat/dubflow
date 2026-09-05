# YupVox Studio Pro V2.5 — Safe Autosave & Conflict Control

Date: 2026-09-05
Status: Approved design direction, awaiting written-spec review
Repository: `trinhtanphat/dubflow`
Base: `main@8c97ead0275169c421f68ebd384364b4776c1d4a` (Studio Pro V2.3 merged)
Branch: `feat/studio-pro-v2-5-safe-autosave-conflicts`

## 1. Goal

Make ordinary transcript editing safe enough for real cloud use without silently losing work.

V2.5 adds revision-aware autosave for segment text and speaker edits, conflict detection across stale tabs/sessions, retryable save states, and undo/redo integration for text/speaker mutations. A stale client must never silently overwrite a newer server segment.

The selected conflict policy is **A — safe reapply**:

- never force-overwrite a newer server version automatically;
- preserve the user's local draft when a conflict is detected;
- fetch/show the canonical newer server segment;
- let the user either discard the local draft or explicitly reapply the local changes against the new server version.

## 2. Approaches considered

### A. Safe reapply — selected

Use the existing per-segment `version` as an optimistic concurrency token. Every editor-driven segment mutation sends the version it was based on. A mismatch returns a conflict instead of writing. The client preserves its draft and offers explicit reapply/discard actions.

Advantages:

- prevents silent lost updates;
- maps directly to the `version` field already persisted in D1;
- conflicts remain scoped to the segment actually being edited;
- no global project lock is required;
- user intent remains explicit when both sides changed.

Trade-off: a conflict requires one extra user decision.

### B. Local always wins — rejected

Force-write the local value after a version mismatch.

Rejected because it can erase newer edits from another tab/session and would violate YupVox's no-silent-data-loss principle.

### C. Automatic field merge — deferred

Automatically merge when server and client changed different fields, asking only for same-field conflicts.

Deferred because it adds three-way merge semantics and field provenance complexity. V2.5 keeps the conflict model deterministic and explicit. A later phase may add safe auto-merge using the same revision protocol.

## 3. Revision model

### 3.1 Authoritative token

The existing `segments.version` column is the authoritative revision token for V2.5 editor mutations.

No new project-wide revision lock is introduced. A project-wide token would cause unnecessary conflicts when two users/tabs edit unrelated segments. Structural operations continue to validate their current segment/lineage state as established in V2.3.

Every canonical segment returned to the frontend includes `version`.

### 3.2 Conditional segment write

Editor-driven `PATCH /api/projects/:id/segments/:segmentId` requires an `expectedVersion` alongside the patch.

Conceptual request:

```json
{
  "expectedVersion": 5,
  "patch": {
    "translatedText": "Xin chào"
  }
}
```

The repository performs a compare-and-swap update:

```text
UPDATE segments
SET ..., version = version + 1
WHERE id = ? AND project_id = ? AND version = ? AND owned-by-current-user
```

The affected-row count must be exactly one. If the segment still exists but its version no longer equals `expectedVersion`, the Worker returns `409 SEGMENT_VERSION_CONFLICT` and includes the current canonical segment in the response.

A missing/unauthorized segment remains fail-closed and must not be confused with a version conflict.

### 3.3 Other editor mutations

Timing edits, undo/redo timing writes, explicit translation apply, and other editor actions that mutate one existing segment must carry the canonical version they are based on and refresh local state from the canonical response.

Split/restore remain cardinality-changing V2.3 operations. V2.5 adds version preconditions to their affected existing segment snapshots and must fail closed when the lineage/current versions are stale. No operation may claim saved after a version mismatch.

## 4. Draft and autosave model

### 4.1 Draft state

Text editing is optimistic in the UI but not immediately considered saved.

Frontend editor state gains a focused draft/autosave domain keyed by segment ID. A draft records:

- base canonical segment snapshot/version;
- user patch being edited;
- save phase: `clean | dirty | saving | error | conflict`;
- last error, when present;
- canonical conflicting server segment, when present.

Playback, timeline zoom/scroll, selection and pointer previews remain transient and outside autosave/history.

### 4.2 Debounce

Source/translated text autosave after **600 ms of inactivity**.

Rules:

- each new keystroke resets the debounce timer;
- blur flushes a dirty draft immediately;
- selecting another segment flushes the current dirty text draft before abandoning its editor surface;
- only one write for the same segment may be in flight at once;
- if edits arrive while a save is in flight, they remain dirty and are saved in a subsequent pass after the canonical response returns;
- the UI must never label a dirty or failed draft as saved.

Speaker assignment is discrete rather than continuous, so it saves immediately using the same revision/conflict protocol.

### 4.3 Save indicator

Topbar/editor status derives from real state:

- `Đã lưu` — no dirty/saving/error/conflict draft;
- `Chưa lưu` — at least one dirty draft;
- `Đang lưu…` — a write is in flight;
- `Lỗi lưu` — retryable non-conflict failure;
- `Xung đột` — stale write rejected; user decision required.

Conflict outranks error, error outranks saving, saving outranks dirty, and dirty outranks saved.

## 5. Conflict UX — policy A

When the server responds with `SEGMENT_VERSION_CONFLICT`:

1. do **not** discard the local draft;
2. store the returned canonical server segment as the new comparison base;
3. stop autosave for that draft until the user resolves it;
4. show a visible conflict banner/card explaining that the segment changed elsewhere;
5. offer exactly two safe actions:
   - **Dùng bản mới trên server** — discard the local patch and replace the editor with the canonical server segment;
   - **Áp dụng lại thay đổi của tôi** — preserve only the fields the user actually changed, rebase that patch onto the new canonical segment/version, then save again using the new expected version.

“Áp dụng lại” is an explicit user-authorized write. It is not an automatic force overwrite. If another writer changes the segment again before the retry, the retry may conflict again and must remain fail-closed.

The conflict UI must display enough context to understand what happened but must not fabricate a semantic merge or silently choose a winner.

## 6. Undo/redo integration

V2.3 history is extended with a general segment field mutation for:

- `sourceText`;
- `translatedText`;
- `speakerId`.

A text editing burst produces **one history entry when the autosave commit succeeds**, not one entry per keystroke.

The entry stores canonical before/after segment snapshots including versions.

Rules:

- dirty draft text is not yet a committed history operation;
- successful autosave pushes one mutation and clears redo as normal;
- speaker change pushes one mutation after its save succeeds;
- undo/redo persist the inverse/forward field patch using the current canonical version, not a stale historical version;
- if undo/redo hits a version conflict, local state is rolled back to the last confirmed canonical state and the same conflict UI is used;
- native text-field Ctrl/Cmd+Z remains available while the user is actively typing; editor-level undo continues to apply outside native text editing.

## 7. Canonical state reconciliation

Every successful mutation response is authoritative.

The frontend must replace the affected segment with the returned canonical row, including:

- new `version`;
- normalized text/speaker/timing values;
- voice/translation status changes made by the Worker.

The client must not predict the next version and must not keep a locally fabricated canonical segment after persistence succeeds.

Hydrating a project from cloud clears obsolete draft/error/conflict state for segments represented by the new snapshot. Unsaved local drafts must not be silently discarded by background hydration; hydration that would replace a dirty/conflicted segment requires an explicit resolution path or is deferred for that segment.

## 8. API and Worker boundaries

### Frontend API

`patchSegment` changes from:

```text
patchSegment(projectId, segmentId, patch)
```

to:

```text
patchSegment(projectId, segmentId, expectedVersion, patch)
```

The client API exposes a typed conflict error carrying the canonical server segment when the Worker returns `409 SEGMENT_VERSION_CONFLICT`.

Split/restore and editor mutation services gain matching version preconditions for the existing segment snapshots they mutate.

### Worker route

The PATCH route validates the request envelope and never trusts a client-supplied replacement version.

Stable responses:

- `200` canonical updated segment;
- `400` malformed expected version or patch;
- `404` missing/unauthorized project/segment;
- `409 SEGMENT_VERSION_CONFLICT` plus current canonical segment;
- existing timing/overlap conflict codes remain distinct from revision conflicts.

### Repository

Repository compare-and-swap is the correctness boundary. Checking the version in application code and then issuing an unconditional UPDATE is insufficient because another writer could change the row between those operations.

The SQL write itself must include the expected version in its WHERE clause and verify affected-row count.

## 9. Error handling and retry

Network/server errors that are not version conflicts:

- keep the local draft;
- mark save state `error`;
- show retry;
- retry against the same expected version unless a fresh server read proves a conflict;
- never push a history entry for a failed save.

Before unload/navigation, if any draft is dirty/saving/error/conflict, the app registers a standard browser unsaved-changes warning where supported.

No background retry loop may spin indefinitely. Automatic retry is limited to the next explicit edit/flush/retry action.

## 10. Component boundaries

### `studioState` / editor domain

Owns:

- canonical project segments;
- editor history;
- per-segment draft metadata;
- conflict state transitions;
- canonical reconciliation actions.

### Autosave coordinator

A focused hook/service owns:

- debounce scheduling;
- one-write-per-segment serialization;
- flush-on-blur/selection;
- retry;
- conflict capture;
- successful commit-to-history orchestration.

It must not own rendering.

### Inspector

Text fields dispatch draft edits rather than immediate canonical segment mutation. Speaker selection uses the same persistence coordinator but flushes immediately.

### Conflict UI

A small dedicated component renders the stale-write explanation and the two policy-A resolution actions. It receives state/actions and contains no D1/network logic.

## 11. Testing strategy

### Pure/reducer tests

- dirty → saving → clean state machine;
- edits while saving remain dirty for a second save pass;
- conflict preserves local patch and canonical server snapshot;
- discard-server resolution clears local patch;
- safe-reapply rebases only user-touched fields onto the new server segment;
- successful text burst creates one history entry;
- history remains capped at 100 operations;
- hydration does not silently erase unresolved local draft state.

### Autosave service tests

- 600 ms debounce coalesces repeated typing;
- blur flushes immediately;
- one request per segment in flight;
- queued newer text saves after the first canonical response;
- network error keeps draft retryable;
- version conflict stops automatic saving until resolution;
- beforeunload guard activates only with unresolved work.

### Worker/repository tests

- matching `expectedVersion` updates one row and increments version;
- stale `expectedVersion` returns `SEGMENT_VERSION_CONFLICT` and current canonical row;
- CAS is enforced in SQL, not only pre-read logic;
- ownership remains fail-closed;
- timing overlap errors remain distinct from version conflicts;
- split/restore reject stale affected segment versions;
- concurrent-style stale tests prove an older request cannot overwrite a newer committed row.

### Integration/component tests

- topbar reports saved/dirty/saving/error/conflict truthfully;
- conflict banner exposes exactly discard-server and safe-reapply actions;
- text typing does not create one history entry per key;
- speaker change is revision-aware and undoable after save;
- native text undo is not stolen while typing.

## 12. Migration strategy

The existing `segments.version` field is reused; no migration is required solely for the revision token.

If implementation discovers legacy rows where `version` can be null or non-positive, add a narrow normalization migration before enabling CAS. Do not add a project-wide lock column merely for convenience.

## 13. Acceptance criteria

V2.5 is complete only when:

1. every editor-driven single-segment save is revision-aware;
2. stale writes cannot silently overwrite a newer segment;
3. text autosave is debounced and truthful about dirty/saving/error state;
4. conflict preserves the local draft;
5. policy-A discard and safe-reapply both work and are tested;
6. text and speaker committed edits participate in bounded undo/redo;
7. failed saves create no false history entry and never display `Đã lưu`;
8. browser unsaved-work protection is active for unresolved drafts;
9. full existing + new tests, TypeScript/Vite production build, Wrangler dry-run, and reference screenshot CI are GREEN on the exact PR head;
10. if `main` changes during implementation, the feature branch is reconciled non-force and requalified on the new exact head before merge;
11. PR is merged to `main` only after exact-head GREEN, then the merge SHA itself receives a fresh post-merge CI verification.

## 14. Out of scope

- automatic semantic/three-way merge of conflicting text;
- local-always-wins force overwrite;
- collaborative cursors/presence;
- real-time WebSocket co-editing;
- production Cloudflare Container credential qualification;
- final dubbed export/voice-cloning capability claims.
