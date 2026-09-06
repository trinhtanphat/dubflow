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

- [ ] **Step 1: Write RED migration/repository tests.** Assert `0010 -> 0011` applies cleanly, `foreign_key_check` is empty, historical exports/shares survive, `projects.source_revision` backfills to `1`, export rows default `mix_mode='dubbed_only'`, owner scoping hides foreign projects, and completed separation requires exact canonical stem keys.
- [ ] **Step 2: Run RED.** `node --test tests/phase4d-migration.test.mjs && npx vitest run worker/test/audio-separation-repository.test.ts` must fail because `0011` and repository do not exist.
- [ ] **Step 3: Implement migration and repository.** Add `source_revision INTEGER NOT NULL DEFAULT 1`; add `audio_separations`; add `project_exports.mix_mode` using a forward rebuild if required to preserve all Phase 4C columns; keep historical `0009`/`0010` untouched.
- [ ] **Step 4: Make source replacement atomic.** `setSourceObject` must set the new object and increment `source_revision = source_revision + 1` only when a new completed upload replaces the durable source.
- [ ] **Step 5: Run GREEN.** Run the same migration/repository tests plus existing Phase 4C migration guard.
- [ ] **Step 6: Commit.** `feat(phase4d): add source revision and separation persistence`.

### Task 2: Domain/provider contract and dedicated separator container

**Files:**
- Create: `worker/src/services/separation/types.ts`
- Create: `worker/src/services/separation/container.ts`
- Create: `worker/src/services/separation/unavailable.ts`
- Create: `worker/src/containers/SeparatorContainer.ts`
- Create: `containers/separator/Dockerfile`
- Create: `containers/separator/server.mjs`
- Create: `containers/separator/separate.mjs`
- Create: `containers/separator/separate.test.mjs`
- Create: `worker/test/separation-provider.test.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
```ts
export type SeparationCapabilities = {
  configured: boolean;
  qualified: boolean;
  provider: string;
  modelId: string;
  modelDigest: string;
};
export type SeparationInput = {
  projectId: string;
  sourceObjectKey: string;
  sourceRevision: number;
  durationMs: number;
};
export type SeparationResult = {
  backgroundObjectKey: string;
  dialogueObjectKey: string;
  durationMs: number;
};
export interface AudioSeparationProvider {
  capabilities(): SeparationCapabilities;
  separate(input: SeparationInput): Promise<SeparationResult>;
}
```

- [ ] **Step 1: Write RED provider/container contract tests.** Reject unqualified capability, invalid source keys, cross-project output keys, missing stem, mismatched duration, floating/empty model digest, path traversal, and request-controlled shell arguments.
- [ ] **Step 2: Run RED.** `npx vitest run worker/test/separation-provider.test.ts && node --test containers/separator/separate.test.mjs`.
- [ ] **Step 3: Implement server-owned deterministic key derivation.** Exact output prefix: `projects/{projectId}/stems/{sourceRevision}/{provider}/{modelDigest}/`; filenames `background.wav` and `dialogue.wav`.
- [ ] **Step 4: Implement dedicated `SeparatorContainer`.** Mirror the safe R2 GET/PUT bridge pattern from `FfmpegContainer`, use a distinct binding, disable arbitrary outbound Internet, and keep model/runtime inputs server-owned.
- [ ] **Step 5: Pin model provenance in image/build inputs.** The image must contain an exact provider/model/digest contract and must not fetch `latest` during a user request.
- [ ] **Step 6: Run GREEN and commit.** `feat(phase4d): add dedicated separation provider container`.

### Task 3: Separation workflow, usage idempotency, and cancellation

**Files:**
- Create: `worker/src/workflows/SeparationWorkflow.ts`
- Create: `worker/src/workflows/separationPipeline.ts`
- Create: `worker/test/separation-workflow.test.ts`
- Modify: `worker/src/db/usage.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
```ts
export type SeparationWorkflowParams = {
  projectId: string;
  userId: string;
  jobId: string;
  separationId: string;
  requestId?: string;
};
```
Operation key: `project:{projectId}:source:{sourceRevision}:separation:{provider}:{modelDigest}`. Usage kind: `audio_separation_minute`.

- [ ] **Step 1: Write RED workflow tests.** Cover first run, completed-stem reuse, started-with-durable-stems recovery, completed-usage-with-missing-stems invariant failure, cancellation before inference, cancellation before completion publish, and provider failure.
- [ ] **Step 2: Run RED.** `npx vitest run worker/test/separation-workflow.test.ts`.
- [ ] **Step 3: Implement minimal workflow pipeline.** Authorize, snapshot source revision/key/duration, check provider capability, resolve canonical identity, meter started, invoke provider under telemetry, validate outputs, persist stems, meter completed, complete job.
- [ ] **Step 4: Extend usage summaries.** Add `audioSeparationMinutes` without changing existing ASR/translation/TTS/render totals semantics.
- [ ] **Step 5: Run GREEN and commit.** `feat(phase4d): add idempotent separation workflow`.

### Task 4: Separation API, rate limit, Cloudflare bindings, and readiness

**Files:**
- Create: `worker/src/routes/separation.ts`
- Create: `worker/test/separation-routes.test.ts`
- Modify: `worker/src/app.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/security/rate-limit.ts`
- Modify: `worker/test/rate-limited-routes.test.ts`
- Modify: `wrangler.jsonc`
- Modify: `worker/src/routes/readiness.ts`
- Modify: `worker/test/readiness.test.ts`

**Interfaces:**
- `POST /api/projects/:id/separation` ensures current canonical separation; returns existing completed/active identity without duplicate provider work.
- `GET /api/projects/:id/separation` returns safe current status/provenance.
- New rate-limit operation `'separation'` -> `RATE_LIMIT_SEPARATION`, initial `2/min`.
- New bindings: `SEPARATOR_CONTAINER`, `SEPARATION_WORKFLOW`.

- [ ] **Step 1: Write RED route/config tests.** Include ownership hiding, idempotent completed/active behavior, failed retry generation, limiter key `user:separation`, and Wrangler binding/class presence.
- [ ] **Step 2: Run RED.** `npx vitest run worker/test/separation-routes.test.ts worker/test/rate-limited-routes.test.ts worker/test/readiness.test.ts` plus deploy-config node tests.
- [ ] **Step 3: Implement routes and bindings.** Mount in `app.ts`, export workflow/container classes from `index.ts`, add env bindings and `wrangler.jsonc` entries.
- [ ] **Step 4: Keep readiness truthful.** Report configured/unqualified separation separately; it must not make general app readiness fail while `dubbed_only` remains supported.
- [ ] **Step 5: Run GREEN and commit.** `feat(phase4d): expose separation preparation API`.

### Task 5: Export mix provenance and fail-closed preserve mode

**Files:**
- Modify: `worker/src/db/project-exports.ts`
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Modify: `worker/src/services/media/types.ts`
- Modify: `worker/src/services/media/container.ts`
- Create/modify: `worker/test/multilanguage-export-route.test.ts`
- Create/modify: `worker/test/project-export-sharing.test.ts`
- Create: `worker/test/phase4d-export-pipeline.test.ts`

**Interfaces:**
```ts
export type DubbedMixMode = 'dubbed_only' | 'preserve_background';
export type RenderExportOptions = {
  targetLanguage: TargetLanguage;
  exportId: string;
  mixMode?: DubbedMixMode;
  backgroundObjectKey?: string;
};
```

- [ ] **Step 1: Write RED export tests.** Omitted mode persists/returns `dubbed_only`; subtitles reject preserve-only semantics; batch applies one mix mode to all dubbed attempts; preserve mode requires a current completed separation matching source revision/provider/model digest; stale/missing fails without mutating `dubbed_only` capability.
- [ ] **Step 2: Run RED.** `npx vitest run worker/test/phase4d-export-pipeline.test.ts worker/test/multilanguage-export-route.test.ts worker/test/project-export-sharing.test.ts`.
- [ ] **Step 3: Implement persistence/API threading.** Pass resolved `mixMode` into export row and Workflow params; include it in DTOs without changing target output keys or share semantics.
- [ ] **Step 4: Implement fail-closed lookup.** `ExportWorkflow` never starts separation implicitly; preserve mode only consumes current durable background stem.
- [ ] **Step 5: Validate media options.** `dubbed_only` forbids background key; `preserve_background` requires exact canonical project/source/provider/model stem prefix.
- [ ] **Step 6: Run GREEN and commit.** `feat(phase4d): add preserve-background export mode`.

### Task 6: FFmpeg preserve-background render graph

**Files:**
- Modify: `containers/ffmpeg/render-export.mjs`
- Modify: `containers/ffmpeg/render-export.test.mjs`
- Modify: `containers/ffmpeg/server.mjs`
- Create: `tests/phase4d-render-acceptance.test.mjs`

**Interfaces:**
- Existing `dubbed_only` graph remains byte/argument compatible in shape: silent base + timeline-fitted dub clips.
- `preserve_background` inputs are source video + validated background WAV + dub clips; original source audio must not be mapped into final audio.

- [ ] **Step 1: Write RED graph tests.** Assert extra background input only in preserve mode, 48k stereo normalization, `amix` background + dubbed clips, no source-audio label in final mix, same video mapping/output duration, and exact modern output key.
- [ ] **Step 2: Run RED.** `node --test containers/ffmpeg/render-export.test.mjs tests/phase4d-render-acceptance.test.mjs`.
- [ ] **Step 3: Implement minimal render branching.** Reuse existing clip tempo/timeline logic; only change base source depending on `mixMode`.
- [ ] **Step 4: Run GREEN and commit.** `feat(phase4d): mix dubbed voices over separated background`.

### Task 7: Studio prepare/status UX and batch mix selection

**Files:**
- Create: `src/features/export/separationApi.ts`
- Create: `src/features/export/separationApi.test.ts`
- Modify: `src/features/export/BatchExportPanel.tsx`
- Modify: `src/features/export/BatchExportPanel.test.tsx`
- Modify: `src/features/export/batchExportApi.ts`
- Modify: `src/features/export/batchExportApi.test.ts`
- Modify: `src/features/export/batch-export.css`

**Interfaces:**
- UI options: `Dubbed voices only`, `Preserve music & ambience`.
- Preserve states: `Not prepared`, `Processing`, `Ready`, `Failed`, `Stale`, `Unqualified`.
- Studio load only fetches status; it never auto-starts separation.

- [ ] **Step 1: Write RED UI/API tests.** Cover no auto-start, explicit prepare action, status mapping, preserve disabled until current ready+qualified, exact `mixMode` in single/batch dubbed requests, subtitle flow unchanged.
- [ ] **Step 2: Run RED.** `npx vitest run src/features/export/separationApi.test.ts src/features/export/batchExportApi.test.ts src/features/export/BatchExportPanel.test.tsx`.
- [ ] **Step 3: Implement minimal UI/API changes.** Keep existing visual hierarchy; add compact audio-treatment control near batch/export controls.
- [ ] **Step 4: Run GREEN and commit.** `feat(phase4d): add background preservation controls`.

### Task 8: Acceptance, deployment guards, and runtime qualification boundary

**Files:**
- Create: `tests/phase4d-background-separation-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `tests/deploy-config.test.mjs`
- Modify: `tests/deploy-plan.test.mjs`
- Modify: `docs/deployment-status.md`

**Interfaces:**
- `npm run verify:deploy-config` must include Phase 4D acceptance + separator container contract test.
- Source/CI status is distinct from runtime qualification.

- [ ] **Step 1: Write RED source acceptance.** Require migration `0011`, exact canonical stem prefix, source revision, separation route/workflow/container/bindings, dedicated limiter, export `mix_mode`, default `dubbed_only`, no manual GitHub deploy workflow, and current Workers Builds migration preparation.
- [ ] **Step 2: Run RED.** `node --test tests/phase4d-background-separation-acceptance.test.mjs`.
- [ ] **Step 3: Wire acceptance into package verify and update docs.** Document that real-media perceptual quality is still `UNQUALIFIED` and list the exact qualification checklist from the spec.
- [ ] **Step 4: Run GREEN and commit.** `test(phase4d): lock separation acceptance boundary`.

### Task 9: Full fresh verification, latest-main reconciliation, PR, merge, post-merge evidence

**Files:** No feature code unless reconciliation reveals a real overlap.

- [ ] **Step 1: Run fresh full verification on exact carrier head.** Required: `npm run verify`, Wrangler dry-run, CJK font install, reference screenshots, artifact upload, separator contract tests. Treat cancelled/concurrency runs as no evidence.
- [ ] **Step 2: Re-fetch carrier and live `main`.** If `main` drifted, compare changed files. Non-overlap may still require a true merge/reconciliation commit because final exact-head evidence must contain live main.
- [ ] **Step 3: Reconcile non-force.** Preserve all deploy/D1 fixes from latest main; never overwrite concurrent changes or historical migrations.
- [ ] **Step 4: Require fresh FULL GREEN after reconciliation.** No merge based on pre-refresh CI.
- [ ] **Step 5: Create PR with exact head/base evidence and runtime `UNQUALIFIED` boundary.** No duplicate PRs.
- [ ] **Step 6: Merge only when mergeable and required/current checks are green.** Use expected-head protection if available; no bypass.
- [ ] **Step 7: Verify live `main` equals merge SHA and require post-merge CI FULL GREEN on that SHA.** Do not manually deploy production; Workers Builds owns production deployment.

## Plan self-review

- Spec coverage: migration/source revision, dedicated container/provider, workflow/idempotency, API/rate limit, export integration, FFmpeg graph, UI, telemetry/usage, deployment policy, and runtime qualification are all assigned to explicit tasks.
- Placeholder scan: no TBD/TODO/"similar to" implementation steps remain.
- Type consistency: `sourceRevision`, `AudioSeparationProvider`, `SeparationWorkflowParams`, `DubbedMixMode`, `mixMode`, `backgroundObjectKey`, `RATE_LIMIT_SEPARATION`, `SEPARATOR_CONTAINER`, and `SEPARATION_WORKFLOW` use one spelling throughout.
