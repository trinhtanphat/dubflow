# Phase 4D Background / Dialogue Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated source-separation lane that produces durable project-scoped dialogue/background stems and lets dubbed exports opt into `preserve_background` without changing the qualified `dubbed_only` default.

**Architecture:** A dedicated `SeparatorContainer` runs pinned two-stem separation behind an `AudioSeparationProvider`. A `SeparationWorkflow` persists one canonical separation identity per project/source revision/provider/model digest, meters it once, and exposes prepare/status routes. `ExportWorkflow` only consumes an already-completed current background stem when `mixMode='preserve_background'`; FFmpeg remains the final renderer.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/Workflows/Containers, D1, R2, React/Vite, Vitest, Node test runner, FFmpeg, pinned Demucs-compatible two-stem runtime.

**Spec:** `docs/superpowers/specs/2026-09-06-phase4d-background-dialogue-separation-design.md`

## Global Constraints

- Base implementation on the current carrier, itself based on `main@baa02d2ff62e064ba00abcfe280d098b54074031`.
- Preserve Workers Builds as the only production deployment lane; GitHub Actions remains CI-only.
- Existing clients that omit `mixMode` must remain `dubbed_only`.
- `preserve_background` must fail closed unless a current completed separation identity exists.
- Separation identity is project + `source_revision` + provider + model digest; never target-language or export scoped.
- Canonical stems live under `projects/{projectId}/stems/{sourceRevision}/{provider}/{modelDigest}/`.
- No production request may download a floating model at runtime.
- Source replacement increments `source_revision`; stale stems are never reused.
- Phase 4D remains runtime `UNQUALIFIED` after source merge until real-media qualification passes.
- Every task follows strict RED -> GREEN -> fresh CI evidence; no force push and no bypass of a red gate.

Implementation started from exact plan head `6fbd253202fd303adc2f55efc001fcc23286d876`.
RED test branch sibling prepared at `e5c8b23c53d9973acd4a9e0d71087bf141e9a742`; it is being merged non-force into the carrier rather than rewriting either line.

---

### Task 1: Forward schema, source revision, and separation persistence

**Files:**
- Create: `migrations/0011_audio_separation.sql`
- Create: `worker/src/db/audio-separation.ts`
- Create: `worker/test/audio-separation-repository.test.ts`
- Modify: `worker/src/db/projects.ts`
- Modify: upload completion path that calls `ProjectStore.setSourceObject(...)`
- Create: `tests/phase4d-migration.test.mjs`

**Interfaces:**
- Produces `Project.sourceRevision: number`.
- Produces `AudioSeparation` with `projectId`, `sourceRevision`, `provider`, `modelId`, `modelDigest`, `status`, `backgroundObjectKey`, `dialogueObjectKey`, `jobId`, `errorCode`, `errorMessage`.
- Produces `AudioSeparationRepository.getCurrent(projectId,userId,sourceRevision,provider,modelDigest)`, `createPending(...)`, `markRunning(...)`, `complete(...)`, `fail(...)`.

- [x] **Step 1: Write RED migration/repository tests.** Added source acceptance + project export mix provenance tests.
- [ ] **Step 2: Run RED.** `node --test tests/phase4d-migration.test.mjs && npx vitest run worker/test/phase4d-project-export-mix.test.ts` must fail because `0011` and mix persistence do not exist.
- [ ] **Step 3: Implement migration and repository.** Add `source_revision INTEGER NOT NULL DEFAULT 1`; add `audio_separations`; add `project_exports.mix_mode` using a forward rebuild if required to preserve all Phase 4C columns; keep historical `0009`/`0010` untouched.
- [ ] **Step 4: Make source replacement atomic.** `setSourceObject` must set the new object and increment `source_revision = source_revision + 1` only when a new completed upload replaces the durable source.
- [ ] **Step 5: Run GREEN.** Run the same migration/repository tests plus existing Phase 4C migration guard.
- [ ] **Step 6: Commit.** `feat(phase4d): add source revision and separation persistence`.

### Task 2: Domain/provider contract and dedicated separator container

- [ ] Write RED provider/container tests.
- [ ] Implement `AudioSeparationProvider`, `SeparatorContainer`, pinned model provenance, deterministic stem keys.
- [ ] GREEN + commit `feat(phase4d): add dedicated separation provider container`.

### Task 3: Separation workflow, usage idempotency, and cancellation

- [ ] RED workflow tests: first run, stem reuse, usage recovery, invariant failure, cancellation boundaries, provider failure.
- [ ] Implement project-level operation key and `audio_separation_minute`.
- [ ] GREEN + commit `feat(phase4d): add idempotent separation workflow`.

### Task 4: Separation API, rate limit, Cloudflare bindings, and readiness

- [ ] RED route/config tests for ownership, idempotency, retry, `RATE_LIMIT_SEPARATION`, `SEPARATOR_CONTAINER`, `SEPARATION_WORKFLOW`.
- [ ] Implement POST/GET separation API and truthful readiness.
- [ ] GREEN + commit `feat(phase4d): expose separation preparation API`.

### Task 5: Export mix provenance and fail-closed preserve mode

- [ ] RED export route/pipeline/share tests.
- [ ] Implement `DubbedMixMode = 'dubbed_only' | 'preserve_background'`, persist/return `mixMode`, require current completed separation, never auto-start it from export.
- [ ] GREEN + commit `feat(phase4d): add preserve-background export mode`.

### Task 6: FFmpeg preserve-background render graph

- [ ] RED graph tests proving preserve mode uses background stem + dub clips and does not remap original source audio.
- [ ] Implement minimal branch while retaining current dubbed-only graph.
- [ ] GREEN + commit `feat(phase4d): mix dubbed voices over separated background`.

### Task 7: Studio prepare/status UX and batch mix selection

- [ ] RED UI/API tests for explicit prepare, no auto-start, status states, exact mixMode, subtitles unchanged.
- [ ] Implement compact `Dubbed voices only` / `Preserve music & ambience` controls.
- [ ] GREEN + commit `feat(phase4d): add background preservation controls`.

### Task 8: Acceptance, deployment guards, and runtime qualification boundary

- [ ] RED source acceptance for 0011, stem prefix, source revision, route/workflow/container/bindings, limiter, mix provenance, default behavior, Workers Builds policy.
- [ ] Wire into `verify:deploy-config`, update deployment status with real-media UNQUALIFIED checklist.
- [ ] GREEN + commit `test(phase4d): lock separation acceptance boundary`.

### Task 9: Full fresh verification, latest-main reconciliation, PR, merge, post-merge evidence

- [ ] Fresh FULL GREEN exact carrier.
- [ ] Reconcile latest main non-force and require fresh FULL GREEN.
- [ ] Create one PR, merge only exact green/mergeable head, no bypass.
- [ ] Verify live main merge SHA and post-merge FULL GREEN.
- [ ] No manual production deploy.

## Plan self-review

Spec coverage is complete for persistence, dedicated container/provider, workflow/idempotency, API/rate limit, export integration, FFmpeg, UI, telemetry/usage, deployment boundary, and runtime qualification. Canonical naming remains `sourceRevision`, `AudioSeparationProvider`, `SeparationWorkflowParams`, `DubbedMixMode`, `mixMode`, `backgroundObjectKey`, `RATE_LIMIT_SEPARATION`, `SEPARATOR_CONTAINER`, `SEPARATION_WORKFLOW`.
