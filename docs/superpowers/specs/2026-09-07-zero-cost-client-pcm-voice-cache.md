# Zero-cost client PCM voice cache design

## Goal

Allow Vietnamese dubbed exports to complete without any paid cloud TTS call by accepting browser-generated 24 kHz mono signed-16-bit PCM for translated segments and reusing the existing zero-container R2 export pipeline.

## Constraints

- No Cloudflare Stream.
- No Cloudflare Containers.
- No AI Gateway credit/top-up requirement.
- No new paid provider or provider secret.
- Keep the existing ElevenLabs/Grok provider selector as a fallback for deployments that intentionally configure/use it.
- The zero-cost lane is initially qualified only for target language `vi`.
- Client audio stored for export must be raw little-endian signed 16-bit mono PCM at exactly 24,000 Hz, matching `PcmSoundtrackService`.
- Translation version is authoritative: stale client audio must never be attached to a newer translation.
- Existing export invalidation semantics remain fail-closed.

## Architecture

The browser generates Vietnamese speech locally using Piper. The backend does not synthesize audio. It accepts a bounded binary PCM upload for one exact translation version, stores it at the same deterministic R2 key already expected by `runZeroContainerExportPipeline`, then marks that translation voice as completed.

The deterministic target key is shared by upload and export code:

`projects/{projectId}/voices/{targetLanguage}/{segmentId}/{version}.pcm`

Export admission changes only for dubbed exports whose complete target-translation set already has exact-version PCM artifacts recorded. When every translation row has `voice_status=completed` and the canonical object key for its current version, server-provider capability is not required. If any artifact is missing or stale, the existing provider capability checks remain unchanged.

The `ExportWorkflow` continues injecting `createVoiceProvider(this.env)`. This is safe because the zero-container pipeline already skips `voice.generate()` for a valid cached artifact. No provider-selection behavior is changed in this carrier.

## Backend API

Add a project-scoped binary endpoint:

`PUT /api/projects/:id/translations/:language/:segmentId/voice-pcm`

Required request contract:

- `Content-Type: application/octet-stream`
- `X-DubFlow-PCM-Format: s16le`
- `X-DubFlow-PCM-Sample-Rate: 24000`
- `X-DubFlow-PCM-Channels: 1`
- `X-DubFlow-Translation-Version: <positive integer>`

Admission:

1. Authorize the project for the current user.
2. Accept only target `vi` in the first qualification.
3. Require the source segment and translation variant to exist.
4. Require translation status `completed` and non-empty translated text.
5. Require the supplied version to equal the current translation version.
6. Require the exact PCM metadata headers above.
7. Require non-empty, even-byte PCM data.
8. Bound one upload to 8 MiB.
9. Store to the canonical target voice key.
10. Mark the target translation voice result using an optimistic/version-safe repository update.

If the translation changes between validation and durable update, return a conflict and do not mark the new version completed. The uploaded stale object is harmless because its key contains the stale version and will never match the new canonical key.

## Persistence

Add a version-safe translation repository method:

`setVoiceResultForVersion(projectId, segmentId, userId, target, expectedVersion, objectKey)`

The update must include `AND version = ?`. If no row changes, reload canonical state and return `TRANSLATION_VARIANT_CONFLICT` when the row still exists, otherwise `TRANSLATION_VARIANT_NOT_FOUND`.

## Export admission

Create/reuse a shared canonical-key helper. A target set is client-voice-complete only when every source segment has exactly one target variant and each variant:

- is translation-completed with non-empty text;
- is `voiceStatus === 'completed'`;
- has `dubbedObjectKey === targetVoiceObjectKey(projectId, targetLanguage, segmentId, version)`.

When complete, dubbed export may launch even if server TTS is unconfigured. Missing/stale client voice falls back to the current provider-capability admission, preserving existing behavior.

## Client carrier (follow-up)

A second carrier will add `@mintplex-labs/piper-tts-web` and use `vi_VN-vais1000-medium` in the browser. Piper returns WAV; the browser will decode/resample to mono 24 kHz and encode raw s16le PCM before calling the endpoint above. The UI will pre-generate only missing/stale Vietnamese voices before starting `dubbed_only` export.

This backend carrier intentionally does not add the Piper dependency yet.

## Qualification

Backend carrier acceptance:

- TDD RED proves route/key/version-safe/cache-aware admission are absent.
- Behavioral tests cover valid upload, invalid PCM metadata, oversize/odd body, stale translation version, unauthorized/missing resources, canonical R2 key, durable completed state, and provider-unconfigured export with fully cached voices.
- Existing provider-backed export tests remain green for incomplete cache.
- Full `npm run verify`, both Wrangler dry-runs, screenshots and artifact upload pass on the exact PR head.
- Merge only after current `main` is revalidated and no overlapping drift exists.

Issue #91 remains open until a real production H.264 fixture completes upload/process/client-Piper voice preload/export and passes H.264/AAC plus packet-preservation gates.
