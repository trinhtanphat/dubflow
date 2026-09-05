# DubFlow Phase 2 Dubbing Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 editor into a working Cloudflare-first dubbing MVP: multipart R2 upload, ASR, translation, persisted editable segments, Vietnamese TTS, timing/export orchestration and truthful frontend controls.

**Architecture:** The Hono Worker owns authorization, metadata and provider orchestration. Large media moves through R2 multipart APIs without buffering whole videos in Worker memory. Workers AI handles Whisper ASR and contextual translation; Google Cloud Translation Basic v2 is the official API-key fallback. TTS is isolated behind a provider adapter and uses Cloudflare AI Catalog `inworld/tts-2` for Vietnamese-capable synthesis; FFmpeg-heavy probe/mix/mux remains behind a narrow media-service interface so it can move to a Cloudflare Container without changing editor/API contracts.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, R2 multipart API, Workers AI / Cloudflare AI Catalog, Google Cloud Translation Basic v2, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-dubflow-design.md`

## Global Constraints

- User-facing product branding is `YupVox.Com`; repository/package remains `dubflow`.
- Source media maximum is 5 GB and 3 hours.
- Target language for V1 is Vietnamese (`vi`).
- Source languages are `auto`, `zh`, `en`, `ja`, `ko`.
- No GitHub Actions and no `.github/workflows` directory.
- The Worker must never buffer a multi-GB source video in memory.
- R2 multipart parts are streamed from `Request.body`; each non-final part must respect R2 multipart minimum sizing.
- Google translation uses the official Cloud Translation Basic v2 endpoint with a Wrangler secret API key; never scrape translate.google.com. Cloud Translation Advanced v3 is not used here because v3 does not support API-key authentication.
- ASR model is `@cf/openai/whisper-large-v3-turbo` behind an adapter.
- Vietnamese TTS uses the Cloudflare AI Catalog adapter for `inworld/tts-2`; no voice-cloning claim or endpoint is enabled without explicit consent/rights and a configured cloning provider.
- Every expensive provider step must be retry-safe and preserve stable project/segment IDs.
- Phase 2 does not add GitHub Actions, payments, or production auth; those remain later phases.

---

### Task 1: Secure R2 multipart source upload

**Files:**
- Modify: `migrations/0001_initial.sql`
- Create: `worker/src/db/uploads.ts`
- Create: `worker/src/routes/uploads.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/test/uploads.test.ts`

**Interfaces:**
- Produces `UploadRepository.create(projectId,userId,key,uploadId)`, `getForUser(projectId,uploadId,userId)`, `markCompleted(...)`, `markAborted(...)`.
- Produces routes:
  - `POST /api/projects/:id/uploads` -> `{ uploadId, key, partSizeBytes }`
  - `PUT /api/projects/:id/uploads/:uploadId/parts/:partNumber` -> `{ partNumber, etag }`
  - `POST /api/projects/:id/uploads/:uploadId/complete` body `{ parts:[{partNumber,etag}] }`
  - `DELETE /api/projects/:id/uploads/:uploadId`

- [ ] **Step 1: Write failing route tests** using fake D1/R2. Assert unauthorized project IDs return 404, create returns an R2 upload ID, part upload passes `Request.body` directly to `uploadPart`, complete records `source_object_key`, and abort is idempotent.
- [ ] **Step 2: Verify RED** with `npm test -- worker/test/uploads.test.ts`; expected failure is missing route/module behavior.
- [ ] **Step 3: Add `media_uploads` D1 table** with `project_id`, `user_id`, `upload_id`, `object_key`, `status`, timestamps, unique `(project_id,upload_id)`.
- [ ] **Step 4: Implement repository and Hono routes**. Use `projects/{projectId}/source/original` as the canonical source key and `32 * 1024 * 1024` as the client part-size recommendation. Reject invalid part numbers and missing request bodies.
- [ ] **Step 5: Verify GREEN** with focused tests and `npm run typecheck`.
- [ ] **Step 6: Commit** as `feat: add secure R2 multipart source uploads`.

### Task 2: ASR adapter and deterministic segment normalization

**Files:**
- Create: `worker/src/services/asr/types.ts`
- Create: `worker/src/services/asr/workers-ai.ts`
- Create: `worker/src/services/asr/normalize.ts`
- Create: `worker/test/asr.test.ts`

**Interfaces:**
- `AsrProvider.transcribe(input: { audio:ArrayBuffer; language?:string; offsetMs:number }): Promise<AsrChunkResult>`.
- `normalizeAsrChunks(projectId,chunks)` returns stable segment IDs derived from project ID + absolute start/end + normalized text, sorted by time.

- [ ] **Step 1: Write failing normalization/provider tests** for timestamp offsets, stable IDs across retries, empty-text removal and `vad_filter:true`.
- [ ] **Step 2: Verify RED** with `npm test -- worker/test/asr.test.ts`.
- [ ] **Step 3: Implement Workers AI adapter** calling `@cf/openai/whisper-large-v3-turbo` with task `transcribe`, optional source language and VAD filtering.
- [ ] **Step 4: Implement deterministic normalization** without random IDs.
- [ ] **Step 5: Verify GREEN** with focused tests + typecheck.
- [ ] **Step 6: Commit** as `feat: add Workers AI transcription adapter`.

### Task 3: Translation provider router

**Files:**
- Create: `worker/src/services/translation/types.ts`
- Create: `worker/src/services/translation/workers-ai.ts`
- Create: `worker/src/services/translation/google.ts`
- Create: `worker/src/services/translation/router.ts`
- Create: `worker/test/translation.test.ts`

**Interfaces:**
- `TranslationInput = { id:string; sourceText:string; sourceLanguage:string; targetLanguage:'vi'; context?:string }`.
- `TranslationProvider.translateBatch(inputs): Promise<Array<{id:string;text:string}>>`.
- Modes: `workers-ai`, `google`, `quality`; quality performs Google draft then Workers AI contextual rewrite while preserving IDs.

- [ ] **Step 1: Write failing tests** proving output IDs cannot be reordered/lost, Google uses only the official `https://translation.googleapis.com/language/translate/v2` endpoint, missing Google secret produces `TRANSLATION_PROVIDER_UNAVAILABLE`, and quality mode preserves cardinality.
- [ ] **Step 2: Verify RED** with `npm test -- worker/test/translation.test.ts`.
- [ ] **Step 3: Implement Google provider** using `POST https://translation.googleapis.com/language/translate/v2?key=...` with `q`, `source`, `target`, and `format:'text'`; the API key comes only from `GOOGLE_CLOUD_TRANSLATE_API_KEY` Wrangler secret and is never returned/logged.
- [ ] **Step 4: Implement Workers AI contextual provider** with strict JSON-shaped output validation and bounded context.
- [ ] **Step 5: Implement router** with deterministic ID reconciliation.
- [ ] **Step 6: Verify GREEN** and commit `feat: add translation provider router`.

### Task 4: Persisted speakers and editable segments API

**Files:**
- Create: `worker/src/db/segments.ts`
- Create: `worker/src/routes/segments.ts`
- Create: `worker/src/routes/speakers.ts`
- Modify: `worker/src/index.ts`
- Create: `worker/test/segments.test.ts`
- Modify: `src/features/projects/useProject.ts`
- Create: `src/features/transcript/segmentApi.ts`

**Interfaces:**
- `GET /api/projects/:id/segments`
- `PATCH /api/projects/:id/segments/:segmentId` accepts bounded source/translated text and timing changes.
- `GET /api/projects/:id/speakers`
- `PATCH /api/projects/:id/speakers/:speakerId` accepts display name and voice assignment fields.

- [ ] **Step 1: Write failing Worker tests** for ownership, ordered segment retrieval, optimistic `version` increment and invalid timing rejection.
- [ ] **Step 2: Verify RED**.
- [ ] **Step 3: Implement repositories/routes** with project-user scoping on every read/write.
- [ ] **Step 4: Add typed frontend clients**; retain deterministic demo only when project list is genuinely empty, never when API errors.
- [ ] **Step 5: Verify GREEN** and commit `feat: persist editable dubbing segments`.

### Task 5: Vietnamese-capable TTS adapter and per-segment generation

**Files:**
- Create: `worker/src/services/voice/types.ts`
- Create: `worker/src/services/voice/cloudflare-inworld.ts`
- Create: `worker/src/routes/voice.ts`
- Create: `worker/test/voice.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- `VoiceProvider.generate({ text, voiceId, language:'vi', speakingRate }): Promise<{ audioUrl:string; provider:string }>`.
- `POST /api/projects/:id/segments/:segmentId/regenerate-voice` stores an immutable R2 version key and increments segment voice version only after provider success.

- [ ] **Step 1: Write failing tests** for Vietnamese text, supported voice IDs, 2,000-character provider bound, project ownership and no state mutation on provider failure.
- [ ] **Step 2: Verify RED**.
- [ ] **Step 3: Implement Cloudflare AI Catalog provider** calling `env.AI.run('inworld/tts-2', { text, voice_id, output_format:'mp3', timestamp_type:'word', speaking_rate })` and validate the returned audio URL.
- [ ] **Step 4: Fetch provider audio server-side and persist to `projects/{projectId}/voices/{segmentId}/{version}.mp3`** only after a successful response. Do not expose voice cloning.
- [ ] **Step 5: Verify GREEN** and commit `feat: add Vietnamese segment voice generation`.

### Task 6: Media service contract, duration fit and export orchestration

**Files:**
- Create: `worker/src/services/media/types.ts`
- Create: `worker/src/services/media/timing.ts`
- Create: `worker/src/services/exports.ts`
- Create: `worker/src/routes/exports.ts`
- Create: `worker/test/timing.test.ts`
- Create: `worker/test/exports.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- `fitAudioDuration(sourceMs,targetMs)` returns `{ speakingRate, padMs, needsReview }`, speaking rate bounded to `0.8..1.25`.
- `MediaService.probe(key)`, `extractAudio(key)`, `renderExport(input)` are HTTP/container-boundary contracts; Worker never shells out to FFmpeg.
- `POST /api/projects/:id/exports` creates an export job only when all required segments have usable audio or are explicitly muted.

- [ ] **Step 1: Write failing pure timing tests** for exact fit, speed-up, slow-down, padding and needs-review bounds.
- [ ] **Step 2: Verify RED**, implement minimal timing math, verify GREEN.
- [ ] **Step 3: Write failing export orchestration tests** for ownership, idempotent export key, missing voice artifacts and media-service failure.
- [ ] **Step 4: Implement export route/service contract** writing output to `projects/{projectId}/exports/{exportId}.mp4`.
- [ ] **Step 5: Verify GREEN** and commit `feat: add timing and export orchestration`.

### Task 7: Enable truthful Phase 2 editor controls

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/features/transcript/ScriptInspector.tsx`
- Create: `src/features/voice/voiceApi.ts`
- Create: `src/features/export/exportApi.ts`
- Modify: `src/app/App.test.tsx`

**Interfaces:**
- Dubbing button starts processing only after a valid uploaded source exists.
- Voice preview/regenerate calls the real segment endpoint and shows loading/error states.
- Export button calls the real export endpoint and never displays completed state before API confirmation.

- [ ] **Step 1: Extend App tests first** for disabled-before-upload, real API invocation, visible provider failure and confirmed export state.
- [ ] **Step 2: Verify RED**.
- [ ] **Step 3: Implement typed API clients and UI state** while preserving the measured desktop layout contract.
- [ ] **Step 4: Verify GREEN** with App tests + typecheck + build.
- [ ] **Step 5: Commit** as `feat: connect studio controls to dubbing pipeline`.

### Task 8: Phase 2 completion verification and delivery docs

**Files:**
- Modify: `README.md`
- Modify: `wrangler.jsonc` only for real required bindings/vars
- Modify: `scripts/verify-no-github-actions.mjs` only if a stronger guard is needed

- [ ] **Step 1: Document `GOOGLE_CLOUD_TRANSLATE_API_KEY` as a Wrangler secret** for Cloud Translation Basic v2 and document Cloudflare AI Catalog/binding requirements without storing values.
- [ ] **Step 2: Document R2/D1 migration and multipart client limits**, including 32 MiB recommended parts and the 5 GB/3 hour product cap.
- [ ] **Step 3: Run `npm run verify`**; expected exit code `0` with tests, typecheck, build and no-actions guard all passing.
- [ ] **Step 4: Run a local/miniflare smoke** for health, project create, upload initiation and one provider-mocked pipeline path.
- [ ] **Step 5: Only after verification succeeds, update the stacked PR from draft to ready and merge in dependency order**: Phase 1 first, then Phase 2 rebased/retargeted to `main`.
