# Browser Piper Vietnamese TTS Design

## Status

Approved architecture for the zero-cost Vietnamese TTS follow-up to #113 / #91.

Base commit at design start: `fefb168c8539efff0e792378eafd47598dd180df`.

## Goal

Let a user export a Vietnamese `dubbed_only` video without any paid server-side TTS call by synthesizing the current Vietnamese translations locally in the browser with Piper, converting the resulting WAV to the exact PCM format already accepted by the #113 backend lane, uploading only missing/stale exact-version voice artifacts, and starting export only after the complete client cache is durable.

## Non-goals

- No Cloudflare Stream.
- No Cloudflare Containers.
- No AI Gateway top-up or credit requirement.
- No new paid provider, provider secret, or server-side TTS fallback.
- No change to Grok's existing explicit paid opt-in gate.
- No server-side Piper runtime.
- No automatic client-Piper qualification for languages other than Vietnamese (`vi`).
- No change to subtitle export.
- No client-Piper qualification for `duck_original` or `separated_background` in this carrier; those modes keep their existing server-provider admission behavior.
- No automatic production fixture on push. Production qualification remains manual and zero-cost-only.

## Existing contracts reused

The browser already receives, for each translation variant:

- `translationStatus`
- `translatedText`
- `voiceStatus`
- `dubbedObjectKey`
- `version`

The #113 backend endpoint is authoritative:

`PUT /api/projects/:id/translations/:language/:segmentId/voice-pcm`

Required request metadata:

- `Content-Type: application/octet-stream`
- `X-DubFlow-PCM-Format: s16le`
- `X-DubFlow-PCM-Sample-Rate: 24000`
- `X-DubFlow-PCM-Channels: 1`
- `X-DubFlow-Translation-Version: <positive integer>`

The canonical object key remains:

`projects/{projectId}/voices/{targetLanguage}/{segmentId}/{version}.pcm`

The backend remains responsible for authorization, language qualification, body bounds, rate limiting, R2 persistence, optimistic translation-version validation, and final cache-aware export admission.

## Runtime dependency

Pin `@mintplex-labs/piper-tts-web` to exact version `1.0.5` rather than a caret range.

The library is browser-only and exposes `download`, `stored`, and `predict`. Its model cache uses the browser Origin Private File System (OPFS). The real model is never downloaded in unit/CI tests.

Qualified voice ID:

`vi_VN-vais1000-medium`

The voice's native sample rate is 22,050 Hz. DubFlow's #113 backend contract requires 24,000 Hz mono signed 16-bit little-endian PCM, so conversion is explicit and deterministic in the browser.

## Architecture

### 1. Piper worker adapter

Create a dedicated browser worker for model download and synthesis so ONNX/WASM inference does not block the Studio UI thread.

The worker owns the Piper dependency and supports a small message protocol:

- `stored` — report whether the qualified Vietnamese model is already cached.
- `download` — ensure the model is in OPFS and stream download progress.
- `predict` — synthesize one text string and transfer the returned WAV bytes back to the main thread.

The worker must never call DubFlow APIs and must never know project IDs or translation versions. Its single responsibility is local TTS runtime execution.

A main-thread adapter wraps worker creation, request IDs, progress events, terminal errors, and teardown. Tests inject a fake adapter; Vitest does not instantiate the real Piper runtime.

### 2. Deterministic WAV-to-PCM conversion

The main thread converts each Piper WAV artifact to backend-ready PCM:

1. Decode WAV with Web Audio `decodeAudioData`.
2. Downmix all decoded channels to mono by averaging samples per frame.
3. Linearly resample the mono floating-point signal from its decoded native sample rate to exactly 24,000 Hz.
4. Clamp samples to `[-1, 1]`.
5. Encode signed 16-bit little-endian PCM.
6. Reject empty, non-finite, or otherwise invalid decoded audio before upload.

The resampling/encoding math lives in pure functions so deterministic unit tests can run without a real audio device or model.

### 3. Client PCM API adapter

Add a frontend API function that uploads one exact translation version to the #113 endpoint with the required headers.

The adapter accepts:

- project ID
- target language (`vi` only from the orchestrator)
- segment ID
- translation version
- raw PCM bytes

It returns the backend's persisted voice result and surfaces a 409 version conflict as a terminal preload failure. The client does not silently synthesize against a newer translation after a conflict; the user can retry export after Studio reloads canonical state.

### 4. Exact-cache detection

A Vietnamese translation artifact is reusable only when all of the following are true:

- translation exists;
- `translationStatus === 'completed'`;
- `translatedText.trim()` is non-empty;
- `voiceStatus === 'completed'`;
- `dubbedObjectKey` exactly equals `projects/{projectId}/voices/vi/{segmentId}/{version}.pcm`.

Anything else is missing/stale and must be regenerated before zero-cost export.

This intentionally mirrors the #113 backend admission rule. A source-contract test locks the frontend key formula to the backend contract.

### 5. Vietnamese preload orchestrator

Create an isolated orchestration function for one target language:

`ensureVietnameseClientVoices(projectId, variants, deps, onProgress)`

Behavior:

1. Require target `vi`; callers do not use it for other languages.
2. Reject incomplete/missing Vietnamese translations before loading Piper.
3. Filter out exact-version cache hits.
4. If no rows need work, return immediately without creating/downloading Piper.
5. Check whether the qualified model is stored; download it once when absent and expose percentage/progress text.
6. Process missing/stale segments sequentially to bound browser CPU/memory:
   - synthesize current `translatedText`;
   - convert WAV to 24 kHz mono s16le;
   - upload with the current translation version;
   - advance segment progress.
7. Return success only after every required upload has completed.

Sequential synthesis is intentional for the first qualification. Parallel model inference is out of scope.

### 6. Studio export orchestration

The integration point is `StudioShell`, before existing `startLanguageExport` / `startBatchExport` calls.

Client Piper is required only when all are true:

- `output === 'dubbed'`
- `audioMode === 'dubbed_only'`
- target language is `vi`

For current-language export:

1. Fetch fresh Vietnamese translation variants immediately before preload. Do not rely only on potentially stale `targetSegments` UI state.
2. Run the client-Piper preload orchestrator.
3. If preload succeeds, update the local Vietnamese variant state when it is the currently displayed language.
4. Start the existing language export.

For batch export:

1. If selected languages include `vi` and mode is `dubbed` + `dubbed_only`, fetch/preload Vietnamese first.
2. Other selected languages keep existing server voice-provider qualification.
3. Start the existing batch export only after Vietnamese preload succeeds.

For retry of a failed Vietnamese `dubbed_only` export, run the same preload gate again. Cache hits make this cheap when the artifacts are already current.

### 7. Availability rules

`BatchExportPanel` currently treats server `VoiceCapabilities` as the only dubbed voice admission source. Extend that rule without weakening non-Vietnamese behavior.

For `vi` + `dubbed_only`:

- a supported browser client-Piper runtime is sufficient to enable the export action even when server voice provider `configured === false`;
- if the browser runtime is unsupported, the existing server provider may still qualify the action;
- when neither path is available, disable the action and show a clear reason.

For non-`vi` languages or non-`dubbed_only` audio modes, preserve current `VoiceCapabilities` admission exactly.

Browser support check is local and side-effect free. It must at minimum require the APIs used by this implementation (Worker, WebAssembly, Web Audio decoding, and OPFS access). Model presence is not a prerequisite; a missing model is downloaded on demand.

### 8. Progress and failure UX

Expose one compact status in the export panel while client voice preload is active. Stages:

- preparing local Vietnamese voice
- downloading model, with percentage when total size is available
- synthesizing segment `n/N`
- uploading segment `n/N`
- ready

The existing export busy state includes preload, so export buttons cannot launch duplicate work.

Any Piper download, worker, audio decode/resample, upload, rate-limit, or translation-version error aborts the export call and appears in the existing export error surface.

Critical fail-closed rule:

**A client-Piper failure never falls through to Grok, ElevenLabs, or any other paid/server TTS call.**

The user must explicitly retry after the local error is resolved. Existing paid Grok behavior remains independently guarded by `PAID_GROK_TTS_ENABLED=true`.

## Component boundaries

### New frontend modules

- `src/features/voice/clientPiperWorker.ts` — Piper worker runtime protocol and model operations.
- `src/features/voice/clientPiper.ts` — main-thread worker adapter and browser capability check.
- `src/features/voice/pcm.ts` — pure downmix/resample/s16le utilities plus WAV decoding wrapper.
- `src/features/voice/clientVoiceApi.ts` — #113 PCM upload API adapter and canonical object-key helper.
- `src/features/voice/clientVoicePreload.ts` — exact-cache detection and sequential preload orchestration.

Exact filenames may be consolidated only if doing so keeps these responsibilities independently testable; unrelated refactoring is forbidden.

### Existing files expected to change

- `package.json` — exact Piper dependency and acceptance-test registration if needed.
- `src/app/StudioShell.tsx` — preload before current/batch/retry export and progress state.
- `src/features/export/BatchExportPanel.tsx` — client-Piper availability/progress display and Vietnamese `dubbed_only` admission.
- existing tests next to those modules.
- a new source-contract acceptance test under `tests/` to lock zero-cost policy and wiring.

No worker backend file is expected to change in this carrier unless a test proves an actual contract mismatch. Such a mismatch upgrades scope and must be reviewed before implementation continues.

## Security and privacy

- Translation text is synthesized locally by the browser Piper runtime instead of being sent to a paid TTS API.
- The model cache is browser-origin local storage (OPFS).
- Generated PCM is uploaded only to the authenticated existing DubFlow project endpoint and stored in the existing project-scoped R2 path.
- No provider keys are exposed to the browser.
- Translation version remains the concurrency authority; stale audio cannot be attached to a newer translation.
- Upload bounds and rate limits remain enforced server-side.

## Cost guarantees

This carrier must not add or enable:

- Cloudflare Containers
- Cloudflare Stream
- paid AI Gateway credit/top-up
- ElevenLabs usage
- Grok TTS usage
- any new paid TTS provider

The client-Piper path requires only user browser compute/bandwidth plus the already-used DubFlow R2/API path. No server TTS call is made for a successfully preloaded Vietnamese `dubbed_only` export.

## Testing strategy

### Source-contract RED first

Before implementation, add an acceptance test wired into `verify:deploy-config` that requires:

- exact Piper dependency pin;
- qualified `vi_VN-vais1000-medium` voice ID;
- OPFS/model-cache-aware browser runtime;
- exact 24,000 Hz / mono / s16le upload headers;
- exact-version canonical cache key;
- preload before Vietnamese `dubbed_only` current, batch, and retry export;
- explicit no-paid-fallback policy.

The initial test-only commit must fail for the intended missing browser-Piper lane before runtime code is added.

### Unit tests

Cover:

- mono pass-through and multi-channel downmix;
- 22,050 → 24,000 linear resampling length and sample stability;
- float clamp and little-endian s16 encoding;
- invalid/empty audio rejection;
- browser capability detection;
- exact model cached/download paths;
- worker progress/error handling with fakes;
- upload endpoint and exact headers;
- exact-cache hit vs missing/stale key/version/status;
- incomplete translation rejection;
- sequential preload and no synthesis for cache hits;
- abort-on-first-error with no export launch.

### Studio/export tests

Cover:

- Vietnamese `dubbed_only` allowed with server provider unconfigured when client Piper is supported;
- unsupported client runtime falls back only to existing server capability admission;
- non-Vietnamese behavior unchanged;
- non-`dubbed_only` behavior unchanged;
- current Vietnamese export waits for preload;
- batch containing Vietnamese waits for preload;
- Vietnamese retry waits for preload;
- preload error surfaces and prevents `startLanguageExport` / `startBatchExport`;
- progress state is visible while busy.

### CI constraints

CI must never download or run the real ~60+ MiB Piper model. Tests mock the worker/runtime. Full qualification still requires:

- `npm run verify`
- checked-in Wrangler dry-run
- generated-production Wrangler dry-run
- reference screenshot gate
- artifact gate

## Production qualification

Issue #91 remains open after code merge until a manual real production qualification proves the complete zero-cost path.

Required final gate:

1. Exact merged `main` passes GitHub CI and both Cloudflare Workers Builds.
2. Open the production Studio through the gateway/custom domain.
3. Upload/process a real deterministic H.264/AAC speech fixture.
4. Produce completed Vietnamese translation variants.
5. With paid Grok opt-in absent/false and no ElevenLabs credential dependency, trigger Vietnamese `dubbed_only` export through the browser client-Piper path.
6. Observe/verify model preload and PCM uploads.
7. Let the existing R2-only export complete.
8. Download the produced MP4.
9. Verify H.264 video + AAC audio with ffprobe.
10. Verify the source H.264 packet-preservation gate used by the zero-container remux qualification.

Production qualification must be manual-only for this carrier so a push cannot unexpectedly download a model or invoke any paid provider.

## Acceptance criteria

The design is complete when all of the following are true:

- Vietnamese `dubbed_only` can be initiated with no configured server TTS provider on a supported browser.
- Only missing/stale exact-version Vietnamese PCM is generated and uploaded.
- The first run downloads/caches the pinned Piper model; later runs reuse it.
- Piper WAV is converted deterministically to 24 kHz mono s16le PCM.
- Translation conflicts and all local/runtime errors fail closed before export.
- No automatic paid/server TTS fallback exists in the client-Piper path.
- Non-Vietnamese and non-`dubbed_only` behavior is unchanged.
- Full exact-head CI is green before merge.
- Latest `main` is revalidated immediately before merge; any drift is reconciled non-force and requalified.
- #91 closes only after the real production zero-cost H.264 → Vietnamese Piper → R2 MP4 gate passes.