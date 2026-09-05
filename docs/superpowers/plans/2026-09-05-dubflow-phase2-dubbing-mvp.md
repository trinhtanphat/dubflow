# DubFlow Phase 2 Working Dubbing MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use TDD for every behavior change.

**Goal:** Turn the Phase 1 workstation into a real cloud dubbing MVP with direct R2 multipart media upload, persisted transcript segments, Workers AI + official Google Cloud Translation, Workers AI ASR, a capability-gated TTS adapter, and export/job boundaries ready for FFmpeg processing.

**Architecture:** Keep the browser/editor independent from AI/provider details. The Worker authorizes project-scoped operations, streams upload parts directly into R2 without buffering multi-GB files, and exposes provider adapters behind small interfaces. Translation and ASR run in Workers AI/Google through deterministic service contracts; media extraction/muxing remains behind an FFmpeg service boundary so the Worker never shells out.

**Tech Stack:** React 19, TypeScript, Hono, Cloudflare Workers Static Assets, R2 multipart API, D1, Workers AI (`@cf/meta/m2m100-1.2b`, `@cf/openai/whisper-large-v3-turbo`), official Google Cloud Translation API v2 over HTTPS, Vitest, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-05-dubflow-design.md`

## Global Constraints

- Keep Phase 1 media target: maximum 5 GB and 3 hours.
- Never proxy the complete source media into Worker memory.
- Source languages stay `auto`, `zh`, `en`, `ja`, `ko`; target stays `vi` for the initial product.
- Workers AI translation uses `@cf/meta/m2m100-1.2b` through `env.AI.run()`.
- Workers AI ASR uses `@cf/openai/whisper-large-v3-turbo` with `task: "transcribe"`.
- Google translation uses the official `translation.googleapis.com/language/translate/v2` API; never scrape translate.google.com.
- Google credentials are read only from Wrangler secrets.
- Timestamps and segment IDs must never be rewritten by an LLM/model response.
- TTS is capability-gated. Do not claim Vietnamese voice generation until the configured provider passes a live capability/smoke check.
- No `.github/workflows`; deployment remains Wrangler-only.

---

### Task 1: Typed Cloudflare Provider Boundaries

**Files:**
- Modify: `worker/src/env.ts`
- Create: `worker/src/cloudflare/r2.ts`
- Create: `worker/src/cloudflare/ai.ts`
- Test: `worker/test/provider-contracts.test.ts`

**Interfaces:**
- Produces `AiBinding.run(model, input, options?)`.
- Produces `R2BucketLike.createMultipartUpload`, `resumeMultipartUpload`, and multipart upload/complete contracts.
- Extends `Env` with `GOOGLE_CLOUD_TRANSLATE_API_KEY?: string`.

- [ ] **Step 1: Write failing compile/contract tests** asserting fake AI/R2 bindings satisfy the interfaces and `Env` accepts the Google secret.
- [ ] **Step 2: Run `npm test -- worker/test/provider-contracts.test.ts` and confirm RED because the contracts do not exist.**
- [ ] **Step 3: Add the minimal provider interfaces** without importing Cloudflare generated types so unit tests remain portable.
- [ ] **Step 4: Run focused test and `npm run typecheck`; require GREEN.**
- [ ] **Step 5: Commit `refactor: type Cloudflare provider bindings`.**

### Task 2: Project-Scoped R2 Multipart Upload

**Files:**
- Modify: `worker/src/db/projects.ts`
- Create: `worker/src/domain/upload.ts`
- Create: `worker/src/services/uploads.ts`
- Create: `worker/src/routes/uploads.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/uploads.test.ts`

**Interfaces:**
- `UploadService.begin(projectId, userId, input) -> { uploadId, objectKey, partSizeBytes }`
- `UploadService.uploadPart(projectId, userId, uploadId, objectKey, partNumber, body) -> { partNumber, etag }`
- `UploadService.complete(projectId, userId, uploadId, objectKey, parts) -> { objectKey, size }`
- `ProjectStore.setSourceObject(id, userId, objectKey, sizeBytes)`.

- [ ] **Step 1: Write RED tests** for allowed MP4/WebM/MKV/MOV, 5 GB rejection, object key confinement to `projects/{projectId}/source/`, invalid part numbers, and complete using returned ETags.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement `normalizeUploadInput()`** with filename sanitization and media-size/type validation reuse.
- [ ] **Step 4: Implement `UploadService.begin()`** using `MEDIA.createMultipartUpload(objectKey)` and return a fixed 25 MiB recommended part size.
- [ ] **Step 5: Implement `uploadPart()`** using `MEDIA.resumeMultipartUpload(...).uploadPart(partNumber, ReadableStream)`; never call `arrayBuffer()` on the full source file.
- [ ] **Step 6: Implement `complete()`** and persist `source_object_key`/size on the authorized project.
- [ ] **Step 7: Mount routes:** `POST /api/projects/:id/uploads`, `PUT /api/projects/:id/uploads/:uploadId/parts/:partNumber`, `POST /api/projects/:id/uploads/:uploadId/complete`.
- [ ] **Step 8: Run focused tests + typecheck GREEN.**
- [ ] **Step 9: Commit `feat: add R2 multipart upload API`.**

### Task 3: Persisted Segment Repository and API

**Files:**
- Create: `worker/src/domain/segment.ts`
- Create: `worker/src/db/segments.ts`
- Create: `worker/src/routes/segments.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/segments.test.ts`

**Interfaces:**
- `SegmentStore.list(projectId, userId)`
- `SegmentStore.updateText(projectId, segmentId, userId, patch)`
- Segment patch may change only `sourceText`, `translatedText`, `speakerId`, `startMs`, `endMs`; project/user identity is immutable.

- [ ] **Step 1: Write RED tests** for ordered list, project authorization, immutable identity, `endMs > startMs`, and version increment.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement domain patch validation and D1 repository.**
- [ ] **Step 4: Add `GET /api/projects/:id/segments` and `PATCH /api/projects/:id/segments/:segmentId`.**
- [ ] **Step 5: Run focused tests + typecheck GREEN.**
- [ ] **Step 6: Commit `feat: persist editable dubbing segments`.**

### Task 4: Translation Provider Contracts and Workers AI Provider

**Files:**
- Create: `worker/src/services/translation/types.ts`
- Create: `worker/src/services/translation/language-map.ts`
- Create: `worker/src/services/translation/workers-ai.ts`
- Test: `worker/test/workers-ai-translation.test.ts`

**Interfaces:**
```ts
export type TranslationItem = { id: string; text: string };
export type TranslationResult = { id: string; text: string; provider: string };
export interface TranslationProvider {
  translateBatch(items: TranslationItem[], source: SourceLanguage, target: 'vi'): Promise<TranslationResult[]>;
}
```

- [ ] **Step 1: Write RED tests** that input IDs are preserved exactly, empty text is preserved without provider calls, and Chinese/English/Japanese/Korean map to model language labels.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement `WorkersAITranslationProvider`** calling `AI.run('@cf/meta/m2m100-1.2b', { text, source_lang, target_lang: 'vietnamese' })` once per item initially; no model output may alter `id`.
- [ ] **Step 4: Normalize known Workers AI response shapes into plain translated text and reject missing output.**
- [ ] **Step 5: Run focused tests GREEN.**
- [ ] **Step 6: Commit `feat: add Workers AI translation provider`.**

### Task 5: Official Google Translation and Translation Router

**Files:**
- Create: `worker/src/services/translation/google.ts`
- Create: `worker/src/services/translation/router.ts`
- Create: `worker/src/routes/translation.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/google-translation.test.ts`
- Test: `worker/test/translation-router.test.ts`

**Interfaces:**
- Modes: `workers-ai`, `google`, `compare`.
- Google request: `POST https://translation.googleapis.com/language/translate/v2?key=<secret>` with JSON `q`, `source`, `target: 'vi'`, `format: 'text'`.
- `compare` returns both provider outputs keyed to the original segment ID; it does not silently choose one.

- [ ] **Step 1: Write RED tests** using injected `fetch` for official Google endpoint, missing-secret failure, HTML entity decoding, order preservation, and compare-mode dual result.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement `GoogleCloudTranslationProvider`** with bounded request timeout and explicit provider error codes.
- [ ] **Step 4: Implement `TranslationRouter`** selecting Workers AI, Google, or compare.
- [ ] **Step 5: Add `POST /api/projects/:id/segments/:segmentId/retranslate`**, load the authorized segment, call router, and persist only accepted single-provider output; compare mode returns alternatives without overwriting text.
- [ ] **Step 6: Run focused tests + typecheck GREEN.**
- [ ] **Step 7: Commit `feat: add Google and translation routing`.**

### Task 6: Workers AI ASR Adapter and Timestamp Normalization

**Files:**
- Create: `worker/src/services/asr/types.ts`
- Create: `worker/src/services/asr/workers-ai.ts`
- Create: `worker/src/services/asr/normalize.ts`
- Test: `worker/test/asr.test.ts`

**Interfaces:**
- `AsrProvider.transcribe(chunk, context) -> AsrChunkResult`.
- `normalizeAsrChunks(chunks)` produces deterministic segment IDs from project/chunk/time identity and applies chunk offset exactly once.

- [ ] **Step 1: Write RED tests** for model name, `task:'transcribe'`, optional source language, VAD enabled, offset application, stable IDs, monotonic timestamps, and rejection of inverted time ranges.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement Workers AI call to `@cf/openai/whisper-large-v3-turbo`.**
- [ ] **Step 4: Normalize response segments without translating them.**
- [ ] **Step 5: Run focused tests GREEN.**
- [ ] **Step 6: Commit `feat: add Workers AI ASR adapter`.**

### Task 7: Capability-Gated TTS Boundary

**Files:**
- Create: `worker/src/services/voice/types.ts`
- Create: `worker/src/services/voice/workers-ai.ts`
- Create: `worker/src/routes/voice.ts`
- Test: `worker/test/voice-capability.test.ts`

**Interfaces:**
- `VoiceProvider.capabilities() -> { languages: string[] | 'unknown'; cloning: false }`.
- `generate()` must reject Vietnamese when provider capability is not explicitly configured/proven.
- No voice-cloning claim in Phase 2.

- [ ] **Step 1: Write RED tests** proving unavailable Vietnamese TTS fails with `VOICE_LANGUAGE_UNVERIFIED` instead of creating fake audio.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement Workers AI voice adapter behind a configured model/speaker boundary, but default capability state remains unavailable until live smoke evidence exists.**
- [ ] **Step 4: Add `GET /api/voice/capabilities`; do not expose a successful generation endpoint for an unverified language.**
- [ ] **Step 5: Run focused tests GREEN.**
- [ ] **Step 6: Commit `feat: add safe TTS capability boundary`.**

### Task 8: Frontend Project, Upload, and Translation API Integration

**Files:**
- Create: `src/lib/api/client.ts`
- Create: `src/features/projects/projectApi.ts`
- Create: `src/features/upload/multipartApi.ts`
- Create: `src/features/translation/translationApi.ts`
- Modify: `src/features/upload/UploadPanel.tsx`
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Modify: `src/app/App.tsx`
- Test: `src/lib/api/client.test.ts`
- Test: `src/features/upload/multipartApi.test.ts`

**Interfaces:**
- `apiFetch<T>` throws `ApiError(status, code, message)` for non-2xx.
- Multipart client uploads sequential or bounded-concurrent parts and sends only part buffers, never one 5 GB body.
- Translation UI supports Workers AI, Google, and Compare labels.

- [ ] **Step 1: Write RED tests** for API error decoding, upload part sizing, completion ETags, and translation mode payloads.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement API client and multipart orchestration.**
- [ ] **Step 4: Wire UploadPanel to validated selected media and real upload progress.**
- [ ] **Step 5: Wire ScriptInspector retranslate action and engine selector; errors remain visible instead of showing fake success.**
- [ ] **Step 6: Run frontend tests + typecheck GREEN.**
- [ ] **Step 7: Commit `feat: connect real upload and translation flows`.**

### Task 9: FFmpeg/Job Boundary Without Fake Export

**Files:**
- Create: `worker/src/services/media/types.ts`
- Create: `worker/src/services/jobs.ts`
- Create: `worker/src/routes/process.ts`
- Modify: `src/app/App.tsx`
- Test: `worker/test/process-boundary.test.ts`

**Interfaces:**
- Job can enter `queued` only if source object exists.
- `MediaProcessor` exposes `probe`, `extractAudio`, and `renderExport`; concrete container transport is injected.
- Until a Cloudflare Container deployment is configured, process/export API returns an explicit `MEDIA_PROCESSOR_UNAVAILABLE` state instead of claiming completion.

- [ ] **Step 1: Write RED tests** for source-required processing and explicit unavailable processor state.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement service/job boundary and status payload.**
- [ ] **Step 4: Replace Phase 2 fake-success UI with real readiness/status messaging; export remains disabled until media processor and TTS capability are live.**
- [ ] **Step 5: Run tests + typecheck GREEN.**
- [ ] **Step 6: Commit `feat: add durable media processing boundary`.**

## Phase 2 Source Completion Gate

Source-level Phase 2 is ready for live Cloudflare qualification only when:

- `npm run verify:no-actions` passes.
- `npm test` passes with published dependencies.
- `npm run build` creates `dist/` successfully.
- R2 multipart route tests prove the Worker never buffers the entire source file.
- Workers AI translation and Google translation provider tests preserve segment identity.
- Workers AI ASR tests preserve source transcript and time offsets.
- TTS remains explicitly unavailable if Vietnamese capability has not passed a live provider smoke test.
- No export is marked complete without a configured media processor.

## Live Cloudflare Qualification Gate

After source completion in a network-enabled environment:

1. `npx wrangler login`.
2. Create/configure D1 and R2 if not already present.
3. `npx wrangler secret put GOOGLE_CLOUD_TRANSLATE_API_KEY`.
4. `npx wrangler d1 migrations apply dubflow-db --remote`.
5. `npm run verify`.
6. `npx wrangler deploy`.
7. Verify `/api/health`, create project, multipart-upload a small fixture, run one Workers AI translation, one Google translation, and one ASR fixture.
8. Probe the configured TTS provider with Vietnamese; only enable Vietnamese voice generation after audible output is confirmed valid.
9. Deploy/configure FFmpeg container before enabling export.

