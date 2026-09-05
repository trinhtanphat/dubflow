# DubFlow Live Pipeline × Studio Pro V2 Reconciliation Design

**Status:** Approved in chat on 2026-09-05.

## Goal

Reconcile the exact-head GREEN live dubbing pipeline from `feat/live-pipeline-ui` onto the current Studio Pro V2.1 `main` without regressing the new shell, responsive behavior, accessibility primitives, capability truthfulness, or deployment configuration.

The resulting implementation must preserve Studio Pro V2.1 as the UI composition authority while adding the already-proven cloud pipeline as backend and feature-layer capabilities.

## Current Provenance

- Current `main`: `665a6369ae61cae979a71e70d8b7efcad4335066`, containing merged Studio Pro V2.1 visual shell.
- Pipeline source head: `72bd05b3ba56a0058792a9b1f26146f1c7330fa0`.
- Pipeline exact-head CI run `33953524351` is GREEN for dependency install, `npm run verify`, production build, and Wrangler dry-run.
- The two histories diverged after merge base `2d6c0e6bb8db238fe1bf2de7dae1f3ca31540d07`, so direct merge/cherry-pick of UI composition files is not acceptable.

## Design Principle

**Studio Pro V2.1 owns composition; the pipeline owns services and cloud state.**

Do not replace `App.tsx`, `StudioShell.tsx`, `StudioTopbar.tsx`, shell primitives, responsive drawers, or Studio Pro styles wholesale with the older pipeline branch versions. Port backend and feature-layer code first, then adapt only the minimum shell interfaces needed to consume live state.

## Reconciliation Strategy

### 1. Port backend and cloud runtime as source-preserving changes

Port the already-GREEN pipeline backend with minimal semantic change:

- FFmpeg Cloudflare Container and R2 bridge
- Cloudflare Workflow binding and `DubbingWorkflow`
- durable job repository and project status mutation
- deterministic ASR segment persistence
- process/job routes
- frontend project/job/segment API clients
- cloud upload flow, job polling, cloud hydration helpers
- editor persistence and retranslation helper
- associated tests and deploy-config assertions

These files are mostly disjoint from Studio Pro V2.1 and should be copied from exact pipeline head rather than rewritten.

### 2. Keep Studio Pro shell as the frontend integration boundary

`App.tsx` remains a thin composition root and continues rendering `StudioShell` through `useStudioState`.

`StudioShell` becomes the integration boundary for live cloud state. It will own or receive:

- current cloud job summary
- active project/job identity
- cloud error state
- editor translation mode/comparison/busy/error state
- callbacks for process start, segment persistence, retranslation, and compare apply

The shell continues to render the existing Studio Pro V2.1 topbar, source rail, center stage, inspector, mobile drawers, and capability strip.

### 3. Extend StudioTopbar truthfully, do not bypass it

`StudioTopbar` remains the only topbar implementation. Add optional props for live cloud progress/status if needed, but preserve:

- existing save state contract
- command/undo/redo controls
- mobile source/inspector controls
- responsive layout and accessibility labels

Cloud job state may appear as a compact status badge/progress text using existing Studio Pro primitives; do not restore the old monolithic topbar markup.

### 4. Upload flow integration

`UploadPanel` keeps Studio Pro placement and styling. On a valid source file:

1. create cloud project
2. multipart upload to R2
3. complete upload
4. start dubbing process
5. return `{ project, job }` to `StudioShell`

The shell starts polling the project-scoped job. Processing copy derives from persisted `currentStep`; no fake completed state is allowed.

### 5. Hydration and state ownership

Before cloud processing, the demo project may remain visible.

Once a real cloud job reaches `needs_review` or `completed`, persisted D1 project/segments become the studio source of truth. Hydration must preserve selected segment where possible and use one UI-only `unassigned` speaker when diarization is absent.

No ASR text-based fake character inference is allowed.

### 6. Editor persistence and retranslation

The Studio Pro inspector receives the live editor capabilities rather than being replaced.

For cloud projects:

- source and translated text remain optimistic locally
- blur persists project-scoped PATCH updates
- speaker assignment persists immediately
- retranslation mode supports `workers-ai`, `google`, and `compare`
- single-provider result replaces the server-backed segment
- compare mode renders two choices and does not persist either until user explicitly applies one
- missing Google credentials/errors stay visible in the inspector

For the demo project, cloud writes remain disabled.

### 7. Capability truthfulness

This reconciliation must not claim unsupported features. TTS preview, voice regeneration, voice cloning, visual lip-sync rendering, and final export stay capability-gated unless independently qualified.

The capability strip and topbar must continue reflecting real availability instead of showing success because source adapters exist.

## Backend Data Flow

```text
Browser
  -> create project
  -> multipart R2 upload
  -> POST /process
  -> durable job + Cloudflare Workflow
       -> FFmpeg Container probe
       -> bounded 5-minute audio chunks in R2
       -> Workers AI Whisper ASR one chunk at a time
       -> deterministic normalized segments
       -> atomic D1 segment replacement
       -> Workers AI translation by default
       -> persisted translations
       -> job/project needs_review or completed
  -> browser polls job every >=2 seconds
  -> browser fetches project + segments
  -> Studio Pro shell hydrates timeline/editor
```

Google Cloud Translation remains an explicit provider/fallback path through the existing official API integration; it is not required for default Workers AI processing.

## Error Handling

- Upload errors remain in the source panel and never start a job.
- Job failures surface the persisted server error code/message.
- Pipeline failures persist both job and project failure state.
- Editor PATCH failures show an inspector error and must not be reported as saved.
- Retranslation failures preserve the prior translation.
- Compare mode never mutates D1 until an explicit apply action.
- Abort/unmount cancels polling timers and ignores late responses.

## Conflict Policy

During reconciliation:

- Prefer current `main` for all Studio Pro shell/style/component files.
- Prefer pipeline head `72bd05b3...` for new backend/runtime/service/API/helper files that do not exist on current `main`.
- For files changed by both lineages (`package.json`, `wrangler.jsonc`, deploy tests, `studioState.ts`, `UploadPanel.tsx`, `ScriptInspector.tsx`), manually combine contracts and add regression tests before implementation.
- Never force-update `main`.
- Implement on a new branch based on the latest `main` and re-check `main` before final merge.

## Testing Strategy

Use TDD for every conflict-bearing integration change.

Required gates:

1. baseline exact-head CI on the new reconciliation branch before production mutation
2. focused RED/GREEN tests for StudioShell cloud orchestration
3. focused RED/GREEN tests for StudioTopbar live job state if its API changes
4. focused RED/GREEN tests for UploadPanel callback integration
5. focused RED/GREEN tests for ScriptInspector cloud persistence/retranslation controls
6. all existing Studio Pro V2.1 shell/accessibility/mobile tests stay GREEN
7. all pipeline backend/provider/job/workflow tests stay GREEN
8. `npm run verify` GREEN
9. `npx wrangler deploy --dry-run` GREEN
10. exact-head GitHub Actions GREEN before PR merge

## Visual Qualification

After source integration is GREEN, perform a dedicated 1448×1086 reference pass without changing the live data architecture. The pass may tune spacing, typography, timeline density, rail widths, footer height, and panel proportions, but must preserve Studio Pro V2.1 responsive/accessibility behavior.

Do not claim literal 100% pixel match without a real browser-render comparison at the target viewport.

## Deployment

Current repository deployment behavior is preserved. This reconciliation does not introduce a new deployment model.

After merge to `main`, existing production deployment automation may run according to current repository configuration. Production runtime is not considered qualified solely from source CI; qualification requires a real Cloudflare run with a small media fixture and persisted translated segments visible through the UI.

## Completion Criteria

The reconciliation is source-complete only when:

- the new branch is based on current `main`
- Studio Pro V2.1 shell/mobile/accessibility behavior is preserved
- FFmpeg Container + Workflow + ASR + translation + D1 pipeline is present
- upload -> process -> poll -> hydrate works through StudioShell
- transcript edits/retranslation persist through project-scoped APIs
- compare mode is non-destructive until apply
- unsupported voice/export features remain guarded
- all tests/build/Wrangler dry-run are GREEN on exact head
- PR is merged only after re-checking current `main`

Production runtime PASS remains a separate qualification gate.
