# Browser Piper Voice Preload Design

## Goal

Complete the zero-cost Vietnamese dubbing lane by generating Vietnamese speech in the user's browser, converting it to the exact PCM format already accepted by the backend, uploading only missing/stale exact-version voice artifacts, and starting the existing R2-only export only after the Vietnamese client voice cache is complete.

This carrier follows backend PR #113 and remains part of issue #91. It must not close #91 by itself; real production H.264 -> dubbed R2 MP4 qualification remains a separate final gate.

## Constraints

- No Cloudflare Stream.
- No Cloudflare Containers.
- No AI Gateway credit/top-up.
- No implicit Grok, ElevenLabs, or other paid TTS fallback.
- Browser Piper is qualified only for target language `vi` in this carrier.
- Existing server-provider behavior remains unchanged for non-`vi` languages.
- Existing separated-background and visual lip-sync capability gates remain unchanged.
- Client PCM upload contract remains exactly: signed 16-bit little-endian, mono, 24,000 Hz, maximum 8 MiB per segment.
- Translation version is authoritative. A voice artifact for version N must never be attached to version N+1.
- Export must not start for `vi` until every current translated segment has a complete exact-version client PCM artifact.

## External dependency and model

Use exact dependency `@mintplex-labs/piper-tts-web@1.0.5` for the first qualification.

Use voice id:

`vi_VN-vais1000-medium`

The Piper voice is a Vietnamese single-speaker medium model. Its native sample rate is 22,050 Hz, so Piper output must not be uploaded directly. The browser must decode the returned WAV and explicitly resample it to mono 24,000 Hz before encoding raw s16le PCM.

The model is roughly 63 MB. It is downloaded lazily on first Vietnamese dubbed export and cached by the Piper library in browser origin-private storage. The initial download is part of the visible preload state, not a hidden background action.

## Existing integration points

`src/app/StudioShell.tsx` already owns `exportCurrent`, `exportBatch`, `retryFailed`, `targetSegments`, `selectedLanguages`, export busy/error state, and language-variant refresh through `getTranslationVariants()`.

`src/features/export/BatchExportPanel.tsx` currently blocks dubbed export solely from server `VoiceCapabilities`. That is no longer sufficient for Vietnamese: `vi` may be exported with a complete browser-generated cache even when the server TTS provider is unconfigured.

`src/features/translation/languageVariantsApi.ts` already exposes current translation version, translated text, voice status, and dubbed object key for every segment. These fields are enough to decide which Vietnamese artifacts are already exact-version cache hits.

Backend PR #113 already exposes:

`PUT /api/projects/:id/translations/:language/:segmentId/voice-pcm`

with the canonical R2 key:

`projects/{projectId}/voices/{targetLanguage}/{segmentId}/{version}.pcm`

## Architecture

Split the client lane into four isolated units.

### 1. Piper runtime adapter

Create a browser-only adapter under `src/features/voice/` that dynamically imports `@mintplex-labs/piper-tts-web` only when Vietnamese voice generation is needed.

Responsibilities:

- expose one configured voice id (`vi_VN-vais1000-medium`);
- download/cache the model on demand;
- report model download progress;
- synthesize one translated text into a WAV `Blob`;
- hide package-specific APIs from the rest of the application.

The adapter must never import Piper eagerly from the application entrypoint.

Prefer running synthesis behind a dedicated Web Worker boundary so ONNX inference does not block Studio rendering. If Vite/package worker bundling proves incompatible during implementation, the runtime may execute through an async browser adapter on the main thread only if the same public interface is retained and qualification proves the UI remains responsive. This is the only implementation flexibility allowed by this spec.

### 2. WAV -> canonical PCM converter

Create a pure conversion unit that accepts decoded audio samples and returns raw signed-16-bit little-endian mono PCM at exactly 24,000 Hz.

Pipeline:

1. Decode Piper WAV using browser audio decoding.
2. Mix all channels to mono by averaging corresponding samples.
3. Resample from the decoded/native sample rate to exactly 24,000 Hz.
4. Clamp float samples to [-1, 1].
5. Encode little-endian signed 16-bit integers with no WAV header.
6. Reject empty output, odd byte length, non-finite samples, or payloads above 8 MiB.

Resampling must be deterministic and unit-testable. Do not rely on `AudioContext.destination` or real-time playback. An `OfflineAudioContext` implementation is acceptable only behind an injected/testable boundary; a small pure linear resampler is preferred for determinism and testability.

### 3. Client voice upload/preload service

Add a small API client for the backend `voice-pcm` endpoint and a preload coordinator.

For one Vietnamese target set:

1. Fetch canonical variants with `getTranslationVariants(projectId, 'vi')` immediately before preload.
2. Require every row to have a completed, non-empty Vietnamese translation.
3. Treat a row as a cache hit only when:
   - `voiceStatus === 'completed'`; and
   - `dubbedObjectKey === projects/{projectId}/voices/vi/{segmentId}/{version}.pcm`.
4. Synthesize/upload only cache misses.
5. Send the exact headers required by #113, including `X-DubFlow-Translation-Version`.
6. Process segments sequentially for the first qualification. This bounds browser memory and prevents multiple ONNX jobs from competing for CPU/RAM.
7. After each successful upload, use the returned version/object key as evidence and update preload progress.
8. After all segments succeed, fetch variants once more and prove the full exact-version cache is complete before allowing export.

### Version conflict handling

If the backend returns `TRANSLATION_VARIANT_CONFLICT` / HTTP 409 during a PCM upload:

- discard the stale synthesized PCM;
- refetch current `vi` variants;
- retry that segment exactly once using the new translated text/version;
- if another conflict occurs, fail the preload and require the user to retry export manually.

No unbounded retry loop is allowed.

### Other upload failures

- 429: fail preload with a retry-later message; do not start export.
- 4xx validation/not-found: fail closed and surface the backend error; do not start export.
- network/model/decode/resample/upload error: fail closed; do not start export.
- abort/navigation: stop current preload and do not start export.

No failure path may automatically invoke a paid TTS provider.

### 4. Export orchestration and UI state

Wrap the existing `exportCurrent`, `exportBatch`, and `retryFailed` paths in `StudioShell.tsx` with a preflight step.

For `output !== 'dubbed'`, behavior is unchanged.

For dubbed export:

- if target language is `vi`, ensure the exact browser PCM cache first;
- if a batch contains `vi`, preload `vi` once before calling `startBatchExport`;
- non-`vi` languages continue to require current server voice capability admission;
- after Vietnamese preload succeeds, call the existing export APIs unchanged.

The preload state is separate from export job state:

```ts
type ClientVoicePreloadState =
  | { phase: 'idle' }
  | { phase: 'loading_model'; percent: number | null }
  | { phase: 'synthesizing'; completed: number; total: number; segmentId: string }
  | { phase: 'uploading'; completed: number; total: number; segmentId: string }
  | { phase: 'verifying'; completed: number; total: number }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; total: number };
```

`exportBusy` must include active preload so repeated clicks cannot launch duplicate synthesis/export.

## Dubbed availability rules

Change `dubbedAvailability()` so it can distinguish local Vietnamese capability from server-provider capability.

Rules:

- `vi`: allowed when the browser environment supports the Piper lane, even if server voice capabilities are unconfigured.
- `vi`: disabled with a clear browser-compatibility reason if the local Piper runtime cannot initialize.
- non-`vi`: retain existing server provider checks exactly.
- separated background and visual lip-sync guards remain additional independent blockers.

Do not advertise Vietnamese as server-TTS configured. The UI should identify this as local/browser voice preparation.

## UI behavior

Keep the existing Batch Export layout. Add only compact progress/status text inside the export panel.

Examples:

- `Đang tải giọng Việt cục bộ: 42%`
- `Đang chuẩn bị giọng Việt 3/8`
- `Đang xác minh voice cache 8/8`
- `Giọng Việt cục bộ đã sẵn sàng.`

While preload is active, export buttons are disabled through the existing busy path.

On failure, show the existing export error surface with a clear zero-cost message. Do not show a button that silently opts into paid TTS. A later separately approved feature may add explicit paid-provider controls, but it is outside this carrier.

## API client contract

Add a function similar to:

```ts
uploadClientVoicePcm({
  projectId,
  targetLanguage: 'vi',
  segmentId,
  version,
  pcm,
}): Promise<{
  targetLanguage: 'vi';
  segmentId: string;
  version: number;
  voiceStatus: 'completed';
  objectKey: string;
}>;
```

The request must use `apiFetch`/the repository's authenticated API conventions rather than raw unauthenticated fetch logic.

## Cache correctness

A local browser/model cache is not evidence that the server voice cache is complete. Only current backend translation rows and canonical R2 object-key metadata determine whether a segment may be skipped.

Changing translated text/version invalidates the old voice artifact naturally because the canonical key includes translation version. The next export must synthesize the new version.

Reloading the page must also work: the browser may reuse the downloaded Piper model, while the server metadata determines which segment audio still needs generation.

## Performance bounds

- Lazy-load Piper only for Vietnamese dubbed export.
- Synthesize sequentially for the first qualification.
- Release object URLs and temporary decoded buffers promptly.
- Do not keep all WAV and PCM buffers for a project in memory simultaneously.
- Abort pending preload on component unmount/project change where practical.
- Do not add service-worker/background scheduling in this carrier.

## Testing

### Source/acceptance gates

Add a source-contract test wired into `verify:deploy-config` proving:

- exact Piper dependency exists;
- Piper is dynamically loaded, not imported from app entrypoint;
- voice id is `vi_VN-vais1000-medium`;
- canonical PCM upload headers are present;
- `StudioShell` preloads Vietnamese cache before export;
- no new Stream/Container/paid-provider secret/config is introduced.

### Unit tests

Cover:

- canonical exact-version key detection;
- cache hit vs missing/stale `dubbedObjectKey`;
- mono conversion;
- 22,050 -> 24,000 resampling output length;
- s16le clipping/endianness;
- empty/oversized output rejection;
- upload headers and binary body;
- sequential preload order;
- already-complete cache performs zero synthesis/upload;
- stale version 409 refetches/retries exactly once;
- second conflict fails closed;
- model/download/synthesis/upload failure prevents export;
- successful preload starts existing export exactly once.

### UI tests

Cover:

- `vi` dubbed export remains enabled with server TTS unconfigured when local Piper is supported;
- non-`vi` provider guard remains unchanged;
- preload progress is visible;
- buttons are disabled while preload is active;
- failure appears in the existing export error surface;
- no implicit paid fallback action appears.

## Qualification gates

Before merge:

1. TDD RED from source/behavioral tests on the new carrier before runtime implementation.
2. Fresh exact-head full CI GREEN.
3. `npm run verify` PASS.
4. Checked-in Wrangler dry-run PASS.
5. Generated-production Wrangler dry-run PASS.
6. Screenshot/artifact PASS.
7. Review exact diff for no Stream, Container, AI Gateway top-up, paid-provider secret, or implicit paid TTS path.
8. Revalidate latest `main`; reconcile non-force on drift and rerun exact-head CI.
9. Merge only on FULL GREEN.

After merge:

- require post-merge CI and backend/gateway Workers Builds SUCCESS;
- keep #91 OPEN;
- then run the authorized real production H.264 fixture through browser Piper preload and R2-only export;
- close #91 only after the final MP4 is playable and H.264 packet-copy/AAC plus durable retry/reload gates pass.

## Non-goals

- No Piper support for `en`, `zh`, `ja`, or `ko` yet.
- No voice picker or multiple Vietnamese speakers.
- No server-side Piper.
- No model hosting migration.
- No paid TTS activation or automatic fallback.
- No production-media qualification claim from CI alone.
