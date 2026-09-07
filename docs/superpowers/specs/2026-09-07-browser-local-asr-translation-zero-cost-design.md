# Browser-local ASR + EN→VI zero-cost design

## Goal

Qualify the production media path without any metered inference. The browser performs source audio decode, Whisper ASR, English-to-Vietnamese Marian translation, and existing Piper Vietnamese TTS. The backend only authenticates, validates, durably commits client inference results, and performs the existing R2 export/remux path.

Canonical flow:

```text
private R2 source / local upload File
  -> browser decode
  -> browser Whisper ASR
  -> browser EN→VI Marian translation
  -> atomic durable client-inference commit
  -> existing browser Piper exact-version PCM cache
  -> existing R2 dubbed_only export/remux
```

## Hard cost boundary

- `Paid-Resources: FORBIDDEN`.
- Never invoke Workers AI, Deepgram, Google Translate, Grok/xAI, ElevenLabs, Sync Labs, Cloudflare Stream, Containers, or any other metered inference/resource from this lane.
- Never call `/api/projects/:id/process` or server translation/retranslate routes from the local coordinator.
- `PAID_WORKERS_AI_ENABLED`, `PAID_DEEPGRAM_ASR_ENABLED`, `PAID_GOOGLE_TRANSLATE_ENABLED`, `PAID_GROK_TTS_ENABLED`, and `PAID_ELEVENLABS_ENABLED` stay absent/OFF.
- Any browser/runtime/model/validation error aborts locally or returns a fail-closed 4xx/409 response. There is no provider fallback.

## Bounded admission

This first qualified lane is deliberately narrow:

- source language: exact `en`
- target language: exact `vi`
- source size: `<= 24 MiB`
- source duration: `> 0 && <= 300000 ms`
- maximum durable segments: `500`
- maximum commit payload: `2 MiB`
- timing: integer milliseconds, non-negative, ordered, non-overlapping, `endMs > startMs`, inside source duration
- source text and translated text must be non-empty after trimming
- one durable project-unique speaker identity is used for all locally inferred segments; no diarization claim is made
- durable commit must match current authenticated project `sourceObjectKey` and `sourceGeneration`

## Immutable browser inference pins

Package:

```text
@huggingface/transformers = 4.2.0
```

ASR:

```text
model: onnx-community/whisper-tiny
revision: 3718def40bb096dd8ab6b3d7518c3fc55016ce66
task: automatic-speech-recognition
language: en
```

Translation:

```text
model: Xenova/opus-mt-en-vi
revision: 3f5f449333cbc7ecaa9eec16ee9e37682f036b8e
task: translation
provenance: browser-opus-mt
```

WebGPU may be preferred when available; supported browser-local WASM fallback is allowed. Neither path may call a hosted inference API. Workers are ES-module browser workers and must not use `eval`, dynamic remote scripts, or server inference endpoints.

## Browser decode and ASR

The existing Mediabunny browser decode boundary is reused. The coordinator keeps the original local `File`, validates size/duration/audio decodability, and obtains bounded mono 16 kHz audio without server decoding. Browser Whisper receives only local decoded audio and returns timestamped text chunks.

The coordinator normalizes Whisper chunks into at most 500 ordered segments. Timing is clamped/validated against authoritative decoded duration before translation. Empty chunks are rejected/filtered deterministically; overlapping or invalid timestamps fail closed rather than being silently repaired into misleading timing.

## Browser translation

Only English-to-Vietnamese is admitted. Marian translation runs in a dedicated browser worker with the immutable model revision above. Results are paired by stable local segment id/index. Missing, duplicate, empty, or count-mismatched outputs abort the commit.

Translation provenance is always `browser-opus-mt`. Local work must never be labelled `workers-ai` or `google`.

## Atomic durable commit

Add one authenticated project route:

```text
POST /api/projects/:id/client-inference/commit
```

The request includes current source identity/generation, duration, immutable model provenance, and ordered locally inferred/translated segments. The backend re-authorizes the project and revalidates every bounded invariant. It must reject stale generation/source identity before mutation.

All durable writes are one D1 `batch`/transactional unit:

1. replace project ASR segments with server-normalized client result ids/timing/text and one project-local speaker identity;
2. persist completed Vietnamese translation variants with `translation_engine='browser-opus-mt'` and voice state `pending`;
3. keep legacy `segments.translated_text`/translation status in sync for compatibility;
4. invalidate stale exports/voice object references affected by replacement;
5. set authoritative project duration;
6. move project and Vietnamese target status to `needs_review` only after the complete batch is admitted.

No partial segment/translation mutation may remain if validation or batch execution fails.

## Schema evolution

The deployed `segments.translation_engine` CHECK currently excludes `browser-opus-mt`. Existing migrations are immutable. If that CHECK still exists on latest `main`, add only a new append-only migration `0013_browser_local_translation_engine.sql` that rebuilds the table safely while preserving rows/indexes/foreign keys and widens the CHECK to include `browser-opus-mt`. `segment_translations.translation_engine` is already free-form but must also persist truthful provenance.

Migration creation is allowed only after confirming `0013` remains unused on latest `main` immediately before the commit.

## Studio orchestration

For admitted EN→VI files, Studio executes local inference instead of calling server processing:

1. upload source normally to private R2 and refresh authoritative project/source generation;
2. run browser decode + Whisper + Marian locally;
3. POST the atomic client-inference commit;
4. reload canonical project/segments/translations from the backend;
5. existing browser Piper preloads exact-version Vietnamese PCM only for missing/stale rows;
6. existing `dubbed_only` export starts only after durable client inference and Piper cache are complete.

If local inference is unsupported or fails, Studio presents a failure and stops. It must never route to `/process`, retranslate, or any paid provider as fallback.

## Verification

Source/CI gates must prove:

- immutable dependency/model pins;
- no server inference calls/fallback strings in the local coordinator;
- browser worker model initialization and bounded input/output validation;
- stale source generation/object key rejected before mutation;
- >5 min, >24 MiB, >500 segments, >2 MiB payload rejected;
- overlap/out-of-bounds/empty/count mismatch rejected;
- atomic persistence and truthful `browser-opus-mt` provenance;
- export/voice invalidation semantics remain correct;
- exact-head full CI, both Wrangler dry-runs, screenshots and artifact pass;
- no paid opt-in is introduced in source/config.

After merge/deploy, #91 remains OPEN until a real authorized browser production fixture proves local Whisper + local Marian + browser Piper + private-R2 MP4 export, reload durability, H.264/AAC codecs, and H.264 packet preservation. Production fixture dispatch is prohibited until the deployed schema/runtime is proven current and the fixture itself cannot enter a metered inference path.
