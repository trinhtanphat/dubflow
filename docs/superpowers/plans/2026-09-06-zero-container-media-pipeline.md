# Zero-Container Media Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the FFmpeg Cloudflare Container dependency in both dubbing and export with Cloudflare Stream, remote Deepgram ASR, and a Worker-native PCM/WAV timeline assembler while preserving D1/R2/job/export contracts.

**Architecture:** Uploads remain durable in R2. A signed, range-capable source route lets the Stream binding ingest the private source object and project rows persist Stream provenance. Dubbing uses Stream audio downloads with Deepgram remote-URL ASR; export generates PCM TTS, assembles one dubbed WAV in R2, attaches it to the Stream asset, generates a downloadable MP4, and copies that MP4 back to the existing R2 export key.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, R2, Workflows, Stream binding/API, Deepgram Nova-3, ElevenLabs, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-zero-container-media-pipeline-design.md`

## Global Constraints

- Keep R2 as source-of-truth for uploaded source media and final exports.
- Keep D1 as source-of-truth for projects/jobs/segments/translations/exports.
- Keep Cloudflare Workflows as orchestration.
- Do not read full long-form source media or project-length dubbed audio into Worker memory.
- Preserve existing final export object keys.
- Do not retain a hidden FFmpeg/Container fallback.
- Fail before job creation when required Stream configuration is absent.

---

### Task 1: Stream provenance, signed source access, and readiness

**Files:**
- Create: `migrations/0011_stream_media.sql`
- Create: `worker/src/cloudflare/stream.ts`
- Create: `worker/src/security/stream-source-token.ts`
- Create: `worker/src/routes/stream-source.ts`
- Modify: `worker/src/db/projects.ts`
- Modify: `worker/src/env.ts`
- Modify: `worker/src/routes/readiness.ts`
- Modify: `worker/src/routes/process.ts`
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/app.ts`
- Test: `worker/test/stream-source.test.ts`
- Test: `worker/test/readiness.test.ts`
- Test: `worker/test/process-route.test.ts`
- Test: `worker/test/export-route.test.ts`

**Interfaces:**
- Produces project fields `streamVideoUid`, `streamSourceObjectKey`, `streamReadyAt` and repository methods `setStreamProvenance(...)`, `clearStreamProvenance(...)`.
- Produces `StreamBindingLike`, `StreamVideoLike`, `StreamDownloadGetResponseLike`.
- Produces `createStreamSourceToken(...)`, `verifyStreamSourceToken(...)`, and `/api/stream-source/:projectId` supporting HEAD/GET/Range.

- [ ] **Step 1: Write failing tests** for migration schema, source-token validation, HEAD/Range behavior, and process/export refusal when `STREAM`, account ID, signing secret, or Stream write token are missing.
- [ ] **Step 2: Run CI and verify RED** because schema 11, Stream env fields, signed source route, and readiness checks do not exist.
- [ ] **Step 3: Implement the minimal schema/env/security/route/repository code** required by those tests.
- [ ] **Step 4: Run CI and verify GREEN** for Task 1 plus the existing suite.
- [ ] **Step 5: Commit** as `feat(media): add Stream provenance and readiness`.

### Task 2: Stream ingest and remote dubbing ASR

**Files:**
- Create: `worker/src/services/media/stream.ts`
- Modify: `worker/src/services/asr/types.ts`
- Modify: `worker/src/services/asr/deepgram.ts`
- Modify: `worker/src/services/asr/router.ts`
- Modify: `worker/src/workflows/pipeline.ts`
- Modify: `worker/src/workflows/DubbingWorkflow.ts`
- Modify: `worker/src/cloudflare/workflows-runtime.d.ts`
- Test: `worker/test/stream-media.test.ts`
- Test: `worker/test/asr.test.ts`
- Test: `worker/test/dubbing-workflow.test.ts`

**Interfaces:**
- `StreamMediaService.ensureSource(projectId, sourceObjectKey)` returns `{ uid, durationMs, audioUrl }` after idempotent ingest/readiness/download generation.
- `RemoteAsrProvider.transcribeUrl(url, context)` returns the existing `AsrChunkResult` shape.
- Dubbing pipeline receives one remote transcription result and persists/reconciles segments with the existing downstream translation path.

- [ ] **Step 1: Write failing tests** proving idempotent Stream reuse, source replacement invalidation, audio-download polling, Deepgram JSON `{url}` request shape, and no `FFMPEG_CONTAINER` access from dubbing.
- [ ] **Step 2: Run CI and verify RED** on missing Stream media service / remote ASR interfaces.
- [ ] **Step 3: Implement Stream ingest/download and remote Deepgram path**, keeping the Workers AI byte-buffer fallback only for explicitly bounded inputs.
- [ ] **Step 4: Run CI and verify GREEN** for dubbing and existing translation/speaker reconciliation tests.
- [ ] **Step 5: Commit** as `feat(dubbing): process Stream audio without containers`.

### Task 3: PCM TTS and streamed dubbed soundtrack

**Files:**
- Create: `worker/src/services/media/pcm.ts`
- Modify: `worker/src/services/voice/types.ts`
- Modify: `worker/src/services/voice/elevenlabs.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Test: `worker/test/pcm-timeline.test.ts`
- Test: `worker/test/elevenlabs-voice.test.ts`
- Test: `worker/test/export-pipeline.test.ts`

**Interfaces:**
- `ElevenLabsVoiceProvider.generate(..., outputFormat)` supports PCM for export while keeping MP3 preview behavior stable.
- `PcmTimelineAssembler` validates signed 16-bit mono PCM, computes source duration from bytes, time-fits each segment to its exact target sample count, writes silence gaps, and produces a streamed WAV body.

- [ ] **Step 1: Write failing tests** for PCM request format, duration math, deterministic sample resampling, silence gaps, overlap rejection, and exact project-duration WAV headers/body size.
- [ ] **Step 2: Run CI and verify RED** on missing PCM APIs.
- [ ] **Step 3: Implement minimal PCM generation/timeline assembly** and integrate voice persistence without `media.probe`.
- [ ] **Step 4: Run CI and verify GREEN** for PCM and export preparation tests.
- [ ] **Step 5: Commit** as `feat(export): assemble dubbed PCM soundtrack in Workers`.

### Task 4: Stream audio-track MP4 export

**Files:**
- Modify: `worker/src/services/media/stream.ts`
- Modify: `worker/src/workflows/exportPipeline.ts`
- Modify: `worker/src/workflows/ExportWorkflow.ts`
- Test: `worker/test/stream-media.test.ts`
- Test: `worker/test/export-pipeline.test.ts`
- Test: `worker/test/multilanguage-export-workflow.test.ts`

**Interfaces:**
- `StreamMediaService.publishDubbedExport(...)` exposes the R2 soundtrack through a signed range URL, calls `/audio/copy`, waits for the track to become `ready`, PATCHes it to `default: true`, generates the Stream `default` MP4 download, and streams it into the exact legacy/target-language R2 key.

- [ ] **Step 1: Write failing tests** for audio-copy API request, ready polling, default-track PATCH, downloadable-MP4 polling, streamed R2 write, and exact object keys.
- [ ] **Step 2: Run CI and verify RED** on missing publishing behavior.
- [ ] **Step 3: Implement minimal Stream export publishing** and wire `ExportWorkflow` to it.
- [ ] **Step 4: Run CI and verify GREEN** for legacy and multilanguage exports.
- [ ] **Step 5: Commit** as `feat(export): publish dubbed MP4 through Stream`.

### Task 5: Remove Container runtime and surface job failures in the UI

**Files:**
- Delete: `worker/src/services/media/container.ts`
- Delete: `worker/src/containers/FfmpegContainer.ts`
- Delete: `containers/ffmpeg/Dockerfile`
- Delete: `containers/ffmpeg/audio-chunks.mjs`
- Delete: `containers/ffmpeg/audio-chunks.test.mjs`
- Delete: `containers/ffmpeg/render-export.mjs`
- Delete: `containers/ffmpeg/render-export.test.mjs`
- Delete: `containers/ffmpeg/server.mjs`
- Delete/replace: `worker/test/media-container.test.ts`, `worker/test/multilanguage-media-container.test.ts`, `tests/render-export-duration.test.mjs`
- Modify: `wrangler.jsonc`
- Modify: `package.json`
- Modify: `worker/src/index.ts`
- Modify: `src/features/upload/UploadPanel.tsx`
- Modify: `src/features/projects/jobPolling.ts`
- Test: `tests/zero-container-config.test.mjs`
- Test: `src/features/upload/cloudUploadFlow.test.ts`

**Interfaces:**
- Wrangler contains `"stream": { "binding": "STREAM" }` and no `containers`, container Durable Object, or `FfmpegContainer` export.
- UI polling renders persisted job stage/error after a successful upload starts processing.

- [ ] **Step 1: Write failing regression/UI tests** proving no runtime Container/FFmpeg references remain and backend job error/stage is visible.
- [ ] **Step 2: Run CI and verify RED** while old Container configuration still exists.
- [ ] **Step 3: Remove Container runtime/dependency/scripts and update UI polling/status copy**.
- [ ] **Step 4: Run full `npm run verify` and Wrangler dry-run in CI; verify GREEN**.
- [ ] **Step 5: Commit** as `refactor(media): remove FFmpeg container runtime`.

### Task 6: Review, refresh, merge, and production proof

**Files:** no feature code unless review/CI finds a concrete defect.

- [ ] **Step 1: Request code review** of the full feature diff against the approved spec.
- [ ] **Step 2: Fix only verified review/CI findings using fresh RED→GREEN cycles.**
- [ ] **Step 3: Compare feature head with latest `main`; refresh without force if drift exists and rerun exact-head CI.**
- [ ] **Step 4: Merge the PR only after exact-head full green CI and close superseded container-restoration PR #66.**
- [ ] **Step 5: Verify post-merge `main` CI, production readiness/schema 11, real-video dubbing beyond the old 5% failure point to `needs_review`, and a playable dubbed MP4 persisted in R2.**
