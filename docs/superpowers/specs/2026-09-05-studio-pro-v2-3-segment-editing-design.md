# YupVox Studio Pro V2.3 — Segment Editing Design

Date: 2026-09-05
Status: Approved design refinement, implementation pending
Repository: `trinhtanphat/dubflow`
Base: Studio Pro V2 design + V2.2 merged player/timeline foundation

## 1. Goal

Deliver trustworthy direct subtitle timing editing on top of the V2.2 real player/timeline foundation. A user must be able to select, move, resize and split a segment directly on the timeline, with snapping, overlap prevention, bounded undo/redo and durable timing persistence.

V2.3 must preserve the V2 principle that playback/view state is transient while durable editor mutations are explicit, testable and never silently lost.

## 2. Scope

Included:

- segment selection on source and translated subtitle lanes;
- drag-to-move while preserving duration;
- left/right edge resize;
- split selected segment at the current playhead;
- snapping to neighboring segment boundaries, playhead and a 100 ms grid;
- hard prevention of invalid overlap and out-of-project timing;
- minimum segment duration of 100 ms;
- bounded undo/redo history with a 100-operation limit;
- one history entry per committed drag/resize, not per pointer-move frame;
- durable persistence of timing/split mutations through the Worker API;
- clear rollback/error behavior when persistence fails;
- tests for timing math, snapping, split behavior, history and Worker validation.

Not included:

- V2.5 revision tokens, autosave debounce/conflict banners;
- arbitrary segment deletion;
- ripple editing across unrelated segments;
- frame-accurate video editing;
- production voice regeneration UI.

## 3. Editing model

### 3.1 Preview vs commit

Dragging is a two-stage operation:

1. `preview`: pointer movement updates a transient proposed timing for rendering only;
2. `commit`: pointer-up validates the final timing, creates exactly one undoable editor mutation and persists it.

Preview state is never added to history and never sent to the backend. Escape cancels a preview and restores the confirmed timing.

### 3.2 Selection

Selection remains transient. Selecting a segment may move the playhead to its start using the existing behavior, but selection itself is not undoable and is not persisted.

The source and target visual blocks for the same segment ID share selection and timing.

## 4. Timing constraints

Pure timeline utilities enforce the same rules before a mutation reaches persistence:

- `0 <= startMs < endMs <= project.durationMs`;
- `endMs - startMs >= 100`;
- moving preserves original duration;
- a segment may not overlap its previous or next subtitle neighbor;
- resize-left cannot cross the previous neighbor or violate minimum duration;
- resize-right cannot cross the next neighbor or violate minimum duration.

Neighbor checks use segments sorted by `startMs`, then stable ID for deterministic tie-breaking.

Automatic operations clamp to the nearest legal boundary instead of creating overlap. If no legal result exists, the commit is rejected and the preview returns to the confirmed state.

## 5. Snapping

Snapping is deterministic and implemented in pure functions.

Candidates, in priority order when distances tie:

1. neighboring segment boundaries;
2. current playhead;
3. 100 ms grid.

A candidate is used only when its screen-space distance is within an 8 px snap threshold at the active zoom level. After snapping, the result is re-clamped to legal timing bounds.

Move operations snap the leading or trailing edge, choosing the candidate that requires the smallest movement while preserving duration. Resize operations snap only the edge being dragged.

## 6. Split behavior

A split is valid only when the playhead is at least 100 ms from both segment edges.

The split creates two segments:

- left: original `startMs` to `playheadMs`;
- right: `playheadMs` to original `endMs`.

The original segment ID remains on the left segment. The backend generates the right segment ID.

Both source and translated text are divided automatically according to the playhead's relative position inside the segment. For each text field independently:

1. compute the relative timing ratio `(playheadMs - startMs) / duration`;
2. choose the nearest sensible text boundary to that ratio;
3. prefer whitespace/word boundaries;
4. when no useful whitespace boundary exists, fall back to the nearest Unicode code-point boundary;
5. trim only boundary whitespace; do not otherwise rewrite text.

This avoids duplicating the entire subtitle into both halves and gives a deterministic starting point that the user can edit afterward.

The right segment inherits the speaker assignment and relevant translation provider metadata from the original. Any generated dubbed-audio reference for the affected segment(s) is considered stale and must not remain presented as current after a split/timing mutation.

## 7. Undo/redo

History lives in the frontend editor domain and is capped at 100 committed operations.

Each entry records enough before/after data to replay or invert the durable mutation. Supported V2.3 history operations:

- move segment;
- resize segment;
- split segment.

The history infrastructure must be extensible so V2.4/V2.5 can include text and speaker mutations without changing its public contract.

Rules:

- transient playback, selection, zoom, scroll and pointer preview never enter history;
- a continuous drag/resize produces one history entry;
- committing a new mutation clears the redo stack;
- undo/redo updates local state immediately, then persists the inverse/forward mutation;
- if persistence fails, local state rolls back to the last confirmed durable state and history pointers are restored so the user can retry;
- active selection is preserved when the referenced segment still exists; after undoing a split, selection returns to the surviving original segment.

## 8. Persistence boundary

V2.3 introduces a focused segment mutation service rather than teaching UI components to coordinate multiple ad-hoc requests.

Frontend API boundary:

```text
commitSegmentTiming(projectId, segmentId, { startMs, endMs })
splitSegment(projectId, segmentId, playheadMs)
restoreSplit(projectId, originalSegment, createdSegmentId)
```

Worker responsibilities:

- verify project ownership;
- validate timing and minimum duration;
- validate neighbor overlap against current D1 state, not only the client snapshot;
- perform split create/update atomically;
- support inverse split restoration atomically for undo;
- return canonical persisted segment rows after each mutation;
- never trust client-generated IDs for a newly split segment.

Existing `PATCH /api/projects/:id/segments/:segmentId` remains valid for ordinary single-segment field/timing updates, but its timing path is strengthened with neighbor-overlap validation. Split uses a dedicated route because it changes row cardinality.

Proposed routes:

```text
PATCH /api/projects/:id/segments/:segmentId
POST  /api/projects/:id/segments/:segmentId/split
POST  /api/projects/:id/segments/:segmentId/restore-split
```

`restore-split` is intentionally narrow: it exists to reverse a split created by the editor history. It is not exposed as general-purpose arbitrary deletion.

Project revision/conflict tokens remain V2.5 work; V2.3 protects correctness through current-state validation and rollback on failed persistence.

## 9. Component boundaries

### Timeline math/domain

Pure modules own:

- legal timing bounds;
- move/resize clamping;
- snap candidate calculation;
- split text boundary calculation.

They must not import React or perform network requests.

### SegmentBlock

`SegmentBlock` becomes a direct-manipulation surface with:

- body drag handle;
- left resize handle;
- right resize handle;
- selected/focused states;
- pointer capture for stable drags;
- accessible labels for resize controls.

It emits semantic preview/commit events rather than mutating project state itself.

### Timeline

`Timeline` owns pointer-to-time conversion, drag lifecycle and transient preview rendering. It delegates durable commit to app/editor actions.

### Studio state/history

`studioState` separates:

- durable project state;
- transient timeline preview;
- `history.past` / `history.future`;
- persistence status for the current mutation.

High-frequency playhead changes remain outside history.

## 10. Error handling

User-visible failures are explicit:

- invalid local timing: commit rejected with a concise timeline message;
- server overlap/current-state rejection: local state rolls back and a retryable error is shown;
- split rejected because playhead is too close to an edge: no mutation/history entry is created;
- network failure during undo/redo: restore the last confirmed state and keep the history action available for retry.

No failed persistence operation may leave the UI claiming the edit is saved.

## 11. Keyboard behavior

V2.3 wires the editing shortcuts that are already defined by the parent V2 spec:

- `S`: split selected segment at playhead, unless focus is inside a text input/textarea/contenteditable;
- `Ctrl/Cmd+Z`: editor undo when focus is not consuming native text editing;
- `Ctrl/Cmd+Shift+Z`: editor redo;
- `Escape`: cancel active drag/resize preview.

Text-field native undo remains native; the global editor must not steal it while typing.

## 12. Testing strategy

### Pure tests

- move preserves duration;
- move clamps to project and neighbor bounds;
- left/right resize minimum duration;
- no-overlap constraints;
- snap threshold varies correctly with zoom;
- snap priority is deterministic;
- split validity near boundaries;
- proportional text split on whitespace and no-whitespace Unicode text;
- history cap, undo, redo and redo clearing.

### Component tests

- selecting source/target blocks selects one segment ID;
- drag preview does not commit repeatedly;
- pointer-up commits once;
- resize handles emit correct semantic operation;
- Escape cancels preview;
- split shortcut is ignored while typing.

### Worker tests

- timing PATCH accepts legal non-overlapping timing;
- timing PATCH rejects overlap based on D1 current state;
- split returns two canonical segments and generates the new ID server-side;
- split is atomic on validation failure;
- restore-split restores the original row and removes only the recorded split child;
- cross-project or non-owner mutation fails closed.

### Gate

Before merge, the exact PR head must pass the repository's authoritative CI including tests, TypeScript/Vite production build and Wrangler dry-run.

## 13. Acceptance criteria

V2.3 is complete only when:

1. a segment can be selected from either subtitle lane;
2. body drag moves it without changing duration;
3. edge drag resizes it without overlap or duration inversion;
4. snapping works against neighbors, playhead and 100 ms grid;
5. split at playhead creates two correctly timed segments with proportional source/translated text;
6. move/resize/split each produce one undoable committed operation;
7. undo/redo can reverse and reapply a split durably;
8. persistence failures roll local state back instead of pretending success;
9. backend current-state validation prevents overlapping timing writes;
10. all new pure/component/Worker tests plus the full existing suite, production build and Wrangler dry-run are GREEN on the exact head before merge.
