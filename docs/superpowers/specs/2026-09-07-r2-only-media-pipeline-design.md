# R2-only media pipeline design

Date: 2026-09-07
Status: proposed for implementation
Base: `main` at `6ca2cedd6eecb999bef0441bfbffc57ba9805cca`

## Goal

Remove Cloudflare Stream completely from DubFlow production while keeping the existing zero-Container architecture and preserving the current public topology:

- backend Worker/state/resources on account `trinhtanphat6666`
- gateway/domain on account `trinhtanphat2403`
- no Cloudflare Containers
- no Cloudflare Stream binding, Stream API token, Stream ingest, Stream downloads, or Stream delivery
- source and final media stored in private R2
- long-form ASR uses signed R2-backed media URLs
- final dubbed MP4 is produced without re-encoding the source video track

## Current problem

The current zero-Container implementation still depends on Cloudflare Stream for two jobs:

1. source preparation: ingest R2 source into Stream, wait for readiness, generate an audio download URL, then send that URL to remote ASR;
2. final publication: copy the dubbed soundtrack into a Stream audio track, make it default, generate an MP4 download, then copy the MP4 back to R2.

This creates an avoidable paid Stream dependency even though the durable source and final artifact are both already R2 objects.

## Options considered

### A. Keep Stream only for muxing

Pros: smallest code change and existing runtime is proven.

Cons: still pays for Stream and keeps Stream credentials/readiness coupling. Rejected because the requested target is zero Stream.

### B. External media processing provider

Send source video plus soundtrack to an external remux/transcode provider and write the result back to R2.

Pros: broad codec support and low Worker CPU pressure.

Cons: adds another paid provider, another secret, another failure domain, and violates the cost-minimization goal. Keep only as a future fallback for unsupported formats, not as the default path.

### C. R2-native signed source + Worker-side transmux/remux

Use private R2 as the durable source of truth. A bounded signed source endpoint exposes the current R2 object to Deepgram and to the remuxer. Preserve the encoded video track, discard the original audio track, encode only the generated PCM soundtrack to AAC, and mux the copied video packets plus the new AAC audio into MP4. Write the result directly to R2.

This is the selected design.

## Selected architecture

```text
Browser upload
    -> private R2 source
    -> D1 project sourceObjectKey

Dubbing Workflow
    -> signed R2 media URL
    -> Deepgram remote ASR directly on source video/audio URL
    -> translation / TTS
    -> PCM timeline + WAV/PCM soundtrack in R2

Export Workflow
    -> read source MP4 from R2
    -> copy encoded video track without decode/re-encode
    -> encode generated PCM soundtrack to AAC
    -> mux video + new audio into MP4
    -> write final MP4 to private R2

Public access
    -> existing authenticated/signed media endpoint through yupvox.qs3d.site
```

Cloudflare production dependencies become Workers + R2 + D1 + Workers AI + Workflows + Analytics/rate limits. Stream is removed from both checked-in and generated production configuration.

## Source preparation

### Signed media endpoint

Replace Stream-specific source signing with a generic R2 media-source grant. The endpoint must:

- require project ownership or a short-lived HMAC token;
- bind the token to project id, exact object key, and expiry;
- serve only the exact current project source object;
- support `HEAD` and byte `Range` requests;
- forward `Content-Type`, `Content-Length`, `ETag`, and range headers where available;
- never list arbitrary R2 keys;
- reject expired, mismatched, or mutated source references.

The existing Stream source token and `/api/stream-source/...` route should be renamed/replaced with media-neutral equivalents rather than retaining Stream terminology.

### ASR

Deepgram remote ASR receives the signed source media URL directly. It supports prerecorded media URLs, so a separate Stream audio extraction stage is unnecessary.

The dubbing pipeline should no longer have stages named `stream_ingest` or `prepare Stream source`. New stages should be media-neutral, for example `preparing_source` and `transcribing`.

Duration comes from the remote ASR result metadata when available. If the provider cannot return a valid duration, the pipeline fails closed instead of trusting an unbounded source. Existing maximum duration policy remains 3 hours.

Workers AI direct-ASR fallback remains bounded by the existing payload and duration budgets. Long-form sources still require a remote-capable ASR provider.

## Final MP4 remux

### Media library

Use `mediabunny` for container parsing/transmuxing and `@mediabunny/aac-encoder` for reliable AAC-LC encoding when native WebCodecs AAC is unavailable in the Worker runtime.

Reasons:

- it can copy encoded video packets without decoding/re-encoding;
- composable conversions support copying the source video while supplying a separately produced audio track;
- it supports MP4 input/output and streaming I/O;
- the AAC extension uses a small WASM encoder, avoiding a Container runtime.

### Accepted standard-export input

For the first production cut, standard dubbed MP4 export is admitted only when the source has one primary video track that can be transmuxed into MP4 without video transcoding. H.264/AVC MP4 is the required baseline. Compatible HEVC may be admitted only when the library reports a valid copy path and the output remains browser-playable.

If the source requires video transcoding, export fails with a specific `VIDEO_TRANSCODE_REQUIRED` error. Do not silently invoke Stream or Containers.

### Audio

The existing PCM soundtrack remains the canonical rendered dialogue timeline. Export encodes that soundtrack once to AAC-LC and adds it as the sole/default audio track in the final MP4. The original source audio track is discarded for `dubbed_only` output.

No full video re-encode occurs.

### Memory and output handling

Do not buffer multi-hour source or output files in a single `ArrayBuffer`.

- read R2 source using ranged access;
- feed the parser incrementally;
- use append-only/streaming MP4 output when the selected Mediabunny MP4 mode supports it;
- otherwise spool bounded chunks to an R2 multipart upload adapter that honors output byte positions;
- keep audio/video packet production in timestamp lockstep to avoid packet-buffer growth;
- enforce explicit maximum in-memory chunk budgets in tests.

If the library configuration cannot produce a safe streaming MP4 for the target runtime, the implementation must fail admission rather than falling back to whole-file buffering.

## Data model

No new required user-visible data model is needed.

The current Stream provenance fields may remain temporarily for backward compatibility but become legacy/unused. A later cleanup migration may remove them after production qualification. The initial implementation must not rewrite historical migrations or replay already-shipped D1 migration filenames.

New export provenance should use existing durable `exportObjectKey` as the canonical artifact identity. No Stream video UID or audio-track UID is required for new exports.

## Configuration changes

Remove from backend production requirements:

- `stream` binding from `wrangler.jsonc`
- `CLOUDFLARE_STREAM_API_TOKEN`
- Stream readiness checks
- Stream deployment documentation

Keep:

- `PUBLIC_ORIGIN`
- the media-source signing secret, renamed to a generic key such as `MEDIA_SOURCE_SIGNING_SECRET`
- `DEEPGRAM_API_KEY` for long-form remote ASR
- `MEDIA` R2 binding

For migration safety, the implementation may temporarily accept the old `STREAM_SOURCE_SIGNING_SECRET` as a fallback alias while deployment moves to `MEDIA_SOURCE_SIGNING_SECRET`. Readiness must clearly report which canonical secret is required before the old alias is removed in a later change.

## Readiness

`/api/ready` schema revision increases by one only if the readiness contract changes in a way that deployment verification must distinguish. The readiness media section should report R2 source/remux capability, not Stream.

A ready standard media runtime requires at least:

- D1 at the admitted schema revision;
- `MEDIA` R2 binding;
- canonical public origin;
- media-source signing secret;
- remote ASR provider for sources exceeding direct-ASR limits;
- remux capability self-check for the admitted baseline MP4 path.

Readiness must not require Cloudflare account id or Stream API token once Stream is removed.

## Error handling

Use specific fail-closed errors:

- `MEDIA_SOURCE_SIGNING_UNAVAILABLE`
- `MEDIA_SOURCE_ORIGIN_UNAVAILABLE`
- `MEDIA_SOURCE_NOT_FOUND`
- `MEDIA_SOURCE_CHANGED`
- `ASR_LONG_FORM_UNAVAILABLE`
- `VIDEO_TRANSCODE_REQUIRED`
- `AUDIO_ENCODE_FAILED`
- `MP4_REMUX_FAILED`
- `R2_EXPORT_WRITE_FAILED`

Persisted historical `getByName` and Stream-specific errors may continue to be sanitized in the UI, but new jobs must never emit Stream errors.

## Testing strategy

Follow TDD with explicit RED -> GREEN slices:

1. config/readiness tests fail if any Stream binding/token remains;
2. signed R2 source route tests ownership, token binding, expiry, HEAD, full body, and byte ranges;
3. dubbing pipeline test proves Deepgram receives the signed source URL directly and no Stream service is constructed;
4. remux unit tests use a tiny fixture MP4 and deterministic PCM soundtrack and verify:
   - output is valid MP4;
   - video sample payload/codec is preserved rather than re-encoded;
   - original audio is absent;
   - new AAC audio is present and duration-bounded;
5. unsupported video codec/container admission returns `VIDEO_TRANSCODE_REQUIRED` before expensive TTS/render work;
6. output writer tests bounded memory/backpressure behavior;
7. export workflow tests durable R2 final object and no Stream provenance/API calls;
8. deployment acceptance rejects `stream` config and Stream secrets/docs;
9. full CI: unit tests, typecheck/build, checked-in Wrangler dry-run, generated-production dry-run, screenshots;
10. post-merge Workers Builds: backend + gateway green and live `/api/ready` on the public domain.

## Rollout

1. Implement on a clean branch from current `main`.
2. Keep Stream production live until the R2-only branch is fully green; source changes alone do not prove runtime qualification.
3. Merge only after exact-head and PR CI are green.
4. Workers Builds deploys backend and gateway from `main`.
5. Verify readiness and a real small MP4 dubbing/export fixture end-to-end.
6. Only after successful live qualification remove old Stream runtime secrets/binding from Cloudflare configuration.
7. Keep no automatic fallback to Stream. A failed R2-only export must fail clearly.

## Success criteria

The change is complete when:

- repository and generated production configs contain no Cloudflare Stream binding;
- no Worker code imports or constructs `StreamMediaService` on the active path;
- dubbing uses a signed R2 source URL directly for remote ASR;
- standard dubbed MP4 export preserves the source video track and writes the final MP4 directly to R2;
- production deploy/readiness succeeds without `CLOUDFLARE_STREAM_API_TOKEN`;
- a live end-to-end small H.264 MP4 job completes without Containers or Stream;
- existing subtitle, translation, TTS, sharing, visual-lip-sync qualification, gateway topology, and D1 migration lineage remain intact.
