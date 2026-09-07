# Browser Piper zero-cost Vietnamese voice design

## Goal

Complete the zero-cost Vietnamese dubbing path started by #113 by generating Vietnamese speech in the user's browser, converting it to the exact PCM contract accepted by the backend, preloading only missing or stale exact-version voice artifacts, and launching the existing R2-only dubbed export only after every Vietnamese translation has a durable matching PCM object.

The browser lane must never create an implicit paid fallback. If browser synthesis, model loading, PCM conversion, or upload fails, dubbed export stops before the server export workflow is launched.

## Current baseline

`main` already contains the #113 backend carrier:

- `PUT /api/projects/:id/translations/:language/:segmentId/voice-pcm` accepts Vietnamese client-generated raw PCM only when the translation version and PCM metadata are exact.
- The backend stores voice artifacts under the deterministic key `projects/{projectId}/voices/{targetLanguage}/{segmentId}/{version}.pcm`.
- Dubbed export may bypass server voice-provider admission only when every current translation has a completed exact-version client PCM artifact.
- Paid Grok TTS is fail-closed by default and requires explicit server opt-in.

The missing piece is frontend orchestration. Today the Studio UI still disables dubbed export whenever the server voice provider is unconfigured, so users cannot reach the zero-cost cache lane even though the backend supports it.

## External runtime choice

Use `@mintplex-labs/piper-tts-web` pinned to the exact package version selected during implementation. The package is browser-only, synthesizes with ONNX Runtime/WebAssembly, caches downloaded model assets in Origin Private File System, and returns a WAV `Blob` from `predict(...)`.

Initial Vietnamese model: `vi_VN-vais1000-medium`.

The upstream model is Vietnamese (`vi_VN`), single-speaker, medium quality, and produces 22,050 Hz audio. The DubFlow backend contract requires raw mono signed-16-bit little-endian PCM at exactly 24,000 Hz, so browser conversion must resample before upload.

The model is intentionally downloaded by the browser on first use rather than bundled into the application or copied into Cloudflare storage. This keeps deployment artifacts small and avoids adding a new server-side model-hosting service.

## Constraints

- No Cloudflare Stream.
- No Cloudflare Containers.
- No AI Gateway credit or top-up.
- No automatic Grok, ElevenLabs, or other paid TTS fallback.
- No new provider secret.
- Zero-cost client synthesis is initially qualified only for target language `vi`.
- Backend PCM contract remains `application/octet-stream`, raw `s16le`, mono, 24,000 Hz, maximum 8 MiB per segment.
- Translation version is authoritative. A voice generated from stale text must never be marked complete for a newer translation.
- Existing non-Vietnamese provider-backed behavior remains unchanged by this carrier.
- Existing subtitle export behavior remains unchanged.
- Existing R2-only export/remux pipeline remains the renderer; the browser only prepares voice artifacts.

## Architecture

Add a small browser voice subsystem with four independent boundaries:

1. **Piper adapter** — dynamically loads the browser-only Piper package, ensures the Vietnamese model is available, synthesizes one translated text string, and returns a WAV `Blob` plus model progress.
2. **PCM converter** — parses Piper's PCM WAV output, converts it to mono signed-16-bit samples, resamples from the WAV sample rate to exactly 24,000 Hz, and returns a raw `Uint8Array` in little-endian s16le format.
3. **Client voice API** — uploads one exact translation version to the #113 endpoint with the required PCM headers and exposes conflict/failure errors without hiding them.
4. **Preload orchestrator** — fetches canonical Vietnamese translation variants, determines which rows are missing or stale, synthesizes/uploads only those rows sequentially, and returns only after every row is durably exact-version complete.

Keep the components independent so model-loading changes, PCM conversion changes, API changes, and Studio orchestration can be tested separately.

## Why sequential synthesis

Generate missing/stale segments sequentially rather than in parallel. The Vietnamese ONNX model is large and browser inference is memory-intensive. A single reusable session avoids multiple model instances and reduces peak memory. The first carrier optimizes correctness and predictable resource use, not maximum throughput.

A later performance carrier may add bounded concurrency only if production measurements justify it.

## Client cache identity

Frontend exact-cache detection mirrors the already-published #113 object-key contract:

`projects/{projectId}/voices/vi/{segmentId}/{version}.pcm`

A Vietnamese translation is already usable only when all of the following are true:

- translation exists;
- `translationStatus === 'completed'`;
- translated text is non-empty after trim;
- version is a positive integer;
- `voiceStatus === 'completed'`;
- `dubbedObjectKey` equals the exact canonical key for the current version.

Anything else is missing/stale and must be regenerated before export.

## PCM conversion

Do not depend on Web Audio APIs for correctness. Piper returns a predictable PCM WAV blob, so conversion is implemented as deterministic TypeScript that can run in browser and Vitest:

1. Parse RIFF/WAVE chunks instead of assuming a fixed header offset.
2. Require one-channel PCM or IEEE-float samples from the known Piper output formats; reject unsupported compressed/multichannel WAV rather than guessing.
3. Normalize samples to floating point in `[-1, 1]` internally.
4. Resample to 24,000 Hz with deterministic linear interpolation for the first carrier.
5. Clamp and encode to signed 16-bit little-endian.
6. Require non-empty even-byte output and enforce the backend 8 MiB maximum before network upload.

The source sample rate comes from the WAV header, not from a hardcoded 22,050 assumption. This keeps the converter correct if the Piper model changes later while preserving the fixed 24 kHz backend contract.

## Piper model loading

The Piper adapter is lazy-loaded only when Vietnamese dubbed export actually needs a missing/stale voice artifact. Normal page load, subtitles, already-complete cached export, and non-Vietnamese flows must not download or initialize the model.

The adapter uses a reusable singleton/session for `vi_VN-vais1000-medium`. Model download progress is surfaced to the Studio state. If the browser lacks required WebAssembly/worker/storage capabilities, or model download fails, the client lane reports unavailable and export remains blocked.

Do not silently change to another Piper voice. The qualified voice ID is explicit and test-locked.

## API contract

Add a frontend API helper for:

`PUT /api/projects/:id/translations/vi/:segmentId/voice-pcm`

Required headers:

```text
Content-Type: application/octet-stream
X-DubFlow-PCM-Format: s16le
X-DubFlow-PCM-Sample-Rate: 24000
X-DubFlow-PCM-Channels: 1
X-DubFlow-Translation-Version: <current positive integer>
```

The request body is the raw PCM byte buffer, not WAV.

A 409 translation-version conflict is terminal for that preload attempt. The orchestrator does not attach stale audio to the new row and does not launch export. The UI asks the user to retry export, which refetches the new canonical text/version and regenerates from that state.

## Preload flow

For a Vietnamese dubbed export request:

1. Fetch fresh canonical `vi` translation variants immediately before synthesis.
2. Reject if any source row lacks a completed, non-empty Vietnamese translation.
3. Filter to missing/stale exact-version voice artifacts.
4. If none are missing, launch export immediately without loading Piper.
5. Otherwise ensure the fixed Piper model/session is available.
6. For each missing/stale row, sequentially:
   - synthesize the row's exact translated text;
   - convert WAV to raw 24 kHz mono s16le;
   - reject locally if output is empty, odd-sized, or over 8 MiB;
   - upload with that row's exact translation version;
   - require successful durable response for the same segment/version.
7. Refetch Vietnamese variants after preload and verify every row now has the exact canonical completed key.
8. Only then call the existing language/batch export API.

If any step fails, stop immediately. No export request is sent, so the backend cannot fall through to a paid provider because of a partially populated cache.

## Studio integration

Integrate at the orchestration layer in `StudioShell.tsx`, not inside the presentation-only export panel.

For `dubbed` + `vi`:

- the current server voice-provider `configured=false` state no longer disables the export button when the browser Piper capability is available;
- clicking export runs the preload flow before `startLanguageExport` or `startBatchExport`;
- export UI shows a deterministic preparation state such as model download, generating segment N/M, or uploading segment N/M;
- while preparation is running, existing export controls remain busy/disabled;
- errors are shown through the existing export error surface;
- after a successful preload, if the current editor language is `vi`, refresh canonical translation rows so voice completion state is reflected in Studio.

For batch export, only the `vi` member uses the client preload lane. Other selected languages continue through existing server capability checks. The carrier does not broaden zero-cost qualification beyond Vietnamese.

## Availability and fail-closed behavior

Introduce a frontend capability result with three states:

- `available` — browser environment can attempt the client Piper lane;
- `preparing` — model download/inference/upload is active;
- `unavailable` — required browser runtime is missing or initialization failed.

The export panel may treat Vietnamese dubbed export as admissible when either:

- the exact client cache is already complete; or
- the browser Piper lane is available and can prepare it.

It must not treat an unconfigured server provider as sufficient by itself.

If client preload fails, do not automatically retry through server TTS even if a server provider happens to be configured. The user can explicitly choose another supported workflow in a separate future feature; this carrier preserves the zero-cost promise.

## Progress and UX

Keep UI changes minimal:

- reuse the existing export busy/error surfaces;
- add one short status line for client-voice preparation;
- show first-download progress when Piper reports it;
- show segment progress during synthesis/upload;
- retain current button labels and result list after export starts.

No new settings page or voice picker is required in this carrier. The Vietnamese voice is fixed for qualification.

## Security and privacy

- Translated text is supplied to browser-local Piper inference and is not sent to a new TTS provider.
- Only generated raw PCM is uploaded to the existing authenticated project endpoint.
- Project authorization, rate limiting, translation-version validation, and R2 persistence remain server-enforced by #113.
- The client must never infer authorization from local state.
- Model assets come from the Piper package's configured public asset/model sources and are cached in browser origin storage; they are not treated as trusted project data.

## Dependency and bundle policy

Pin the Piper package to an exact version in `package.json`/lockfile during implementation. Load it dynamically so the normal Studio bundle does not eagerly initialize the browser-only runtime.

Do not copy the 60+ MiB model into the repository, Vite public assets, R2, or Worker bundle. CI source/build tests may mock only the Piper adapter boundary; PCM conversion and orchestration logic must be exercised as real code.

## Testing strategy

TDD is mandatory.

### RED contract

Before production implementation, add tests that fail because the browser lane is absent:

- Vietnamese dubbed export is not blocked solely by unconfigured server voice when client Piper is available.
- Export preloads missing/stale exact-version Vietnamese voices before launch.
- Export is not launched if one preload fails.
- Already exact-complete cache skips Piper entirely.

### PCM unit tests

- parse RIFF chunks without fixed offsets;
- convert Piper-style mono WAV to exact raw s16le;
- resample a deterministic signal to 24,000 Hz;
- reject malformed/unsupported/multichannel input;
- clamp samples correctly;
- reject empty/oversized converted output.

### API tests

- exact endpoint path;
- exact five PCM/version headers;
- raw binary body;
- 409 conflict is preserved as an actionable failure.

### Orchestration tests

- only missing/stale rows synthesize;
- synthesis is sequential;
- every upload uses the row's exact current version;
- post-preload canonical refetch is required before export;
- partial success never launches export;
- batch flow preloads only `vi` and preserves existing handling for other languages.

### Full repository gate

Require fresh exact-head:

- `npm run verify` PASS;
- checked-in Wrangler dry-run PASS;
- generated-production Wrangler dry-run PASS;
- reference screenshots PASS;
- artifact upload PASS;
- no Cloudflare Stream/Container config additions;
- no AI Gateway credit/top-up or paid-provider secret/config additions.

## Production qualification

Merging this carrier does not close #91 by itself.

After deployment, manually run the production H.264 fixture through the public gateway with the browser client lane performing Vietnamese voice preload. Qualification requires:

1. readiness/schema/R2/remux PASS;
2. real upload and ASR/translation PASS;
3. browser Piper generates and uploads exact-version Vietnamese PCM;
4. `dubbed_only` export completes without any paid TTS inference;
5. final MP4 is private-R2 backed and publicly playable through the gateway;
6. video remains H.264 packet-copy compatible;
7. dubbed soundtrack is AAC;
8. reload/retry preserves durable state;
9. provider/build/client-Piper provenance is recorded.

Only after all production gates pass may #91 be closed.

## Out of scope

- Voice picker or multiple Vietnamese Piper voices.
- Voice cloning.
- Non-Vietnamese client TTS.
- Parallel multi-segment inference.
- Service Worker/background synthesis.
- Server-hosted Piper model assets.
- Automatic paid-provider fallback.
- Changing ASR, translation, remux, visual lip-sync, or dialogue-separation architecture.
