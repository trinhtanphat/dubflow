# YupVox deployment status

Canonical public hostname: `yupvox.qs3d.site`

## Current Cloudflare topology

Production uses a split Cloudflare topology.

- Public zone/gateway account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`. It owns `qs3d.site`, the `yupvox.qs3d.site` custom domain, TLS, and the thin `dubflow-gateway` Worker.
- Backend/state account: `6c5207813df3d5b83b9508125e0e9e12`. It owns the `dubflow` backend Worker and persisted production data in D1/R2 together with Workers AI, Analytics Engine, Workflows, rate-limit resources, and provider state.

The gateway owns no DubFlow database or media state. It forwards the public hostname to the configured backend origin. `main` remains the repository source of truth. GitHub Actions is CI only and **must not deploy production**. Cloudflare Workers Builds is the production deployment lane.

## Containers and Stream removed from admitted media runtime

Cloudflare **Containers are disabled in production**. The FFmpeg Container runtime has been removed from the active dubbing and `dubbed_only` export path. Historical FFmpeg/Demucs material does not imply a deployed Container. Hybrid audio modes that still need an unimplemented media treatment remain fail-closed instead of silently falling back.

The admitted standard media path is now **R2-only** and has no Cloudflare Stream production dependency. Checked-in and generated backend configs contain no Stream binding. New jobs do not require `CLOUDFLARE_STREAM_API_TOKEN`, Stream ingest, Stream download, or Stream delivery.

## Current R2-only source and export path

The current source path is:

R2 multipart upload -> short-lived signed R2 media URL -> remote ASR (Deepgram when configured, bounded Workers AI fallback where admitted) -> speaker reconciliation -> translation -> per-speaker ElevenLabs TTS -> Worker-native PCM/WAV soundtrack assembly -> H.264/AVC packet-copy + AAC soundtrack MP4 remux -> private R2 final artifact.

The standard export baseline requires an MP4 source with one H.264/AVC video track that can be packet-copied without video decode/re-encode. Unsupported video fails closed with `VIDEO_TRANSCODE_REQUIRED`; there is no automatic Stream or Container fallback. Ranged R2 reads and multipart R2 writes keep multi-hour media off the whole-file `ArrayBuffer` path.

Canonical media-source signing uses `MEDIA_SOURCE_SIGNING_SECRET`. `STREAM_SOURCE_SIGNING_SECRET` remains accepted only as a temporary migration alias while the live secret is rolled over. `PUBLIC_ORIGIN` remains canonical and points at `https://yupvox.qs3d.site`.

Migration `0012_visual_lipsync.sql` keeps its historical filename because production D1 already recorded that exact migration name. Migration `0012_stream_media.sql` also remains unchanged because it was shipped and contains legacy nullable Stream provenance fields. Those fields are historical/readable but are not authoritative for new jobs. Neither migration is renamed, replayed, collapsed, or rewritten.

The deployment/readiness contract is schema revision **14**. This is a logical readiness revision for the R2-only media contract; it does not imply rewriting the historical migration ledger. Readiness structurally verifies the existing D1 schema and reports `media.r2` and `media.remux` capability. The deployment verifier rejects stale HTTP-200 payloads that do not report exact revision 14 with both media capabilities ready.

Canonical target artifacts include:

- voice clips: `projects/{projectId}/voices/{targetLanguage}/...`
- soundtrack: `projects/{projectId}/soundtracks/{targetLanguage}/{exportId}.wav`
- subtitles: `projects/{projectId}/subtitles/{targetLanguage}/{exportId}.srt`
- standard dubbed export: `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`
- optional visual result: `projects/{projectId}/exports/{targetLanguage}/{exportId}.lipsync.mp4`

Visual lip-sync does **not** re-extract export audio with FFmpeg. Sync Labs receives the already-rendered standard MP4 plus the durable PCM/WAV soundtrack through bounded provider-media grants. Standard MP4 publication completes first and remains durable even if the optional visual operation fails.

## Runtime configuration

A ready standard R2-only media runtime requires the `MEDIA` R2 binding, `PUBLIC_ORIGIN`, `MEDIA_SOURCE_SIGNING_SECRET` (or the temporary legacy alias during rollout), the admitted D1 schema, and a working bundled remux/AAC capability. Long-form dubbing additionally requires a remote-capable ASR provider such as Deepgram. No Cloudflare account id or Stream API token is part of media readiness.

`SYNC_API_KEY` is optional: when absent, standard R2-only dubbing/export stays available while visual lip-sync admission reports unavailable. `SYNC_LIPSYNC_QUALIFIED=true` remains a separate explicit qualification gate for visual output. Secret values are never committed. Source CI does not claim that a real external provider is configured.

## Phase 3B usage qualification

Phase 3B keeps the durable idempotent usage ledger authoritative for ASR, translation, generated TTS audio, final render, and optional visual lip-sync usage. Persisted/API units remain seconds for ASR/TTS/render/lip-sync and Unicode source characters for translation. Retry/provider operation identity prevents Workflow replay from duplicating the same logical completed provider work. `users.credit_balance` remains informational/read-only.

## Phase 3C observability, rate-limit, and sharing qualification

Phase 3C source/CI qualification uses the `dubflow_events` Analytics Engine dataset and bounded operational telemetry. Payloads, transcripts, media contents, raw bearer tokens and provider secrets remain outside the telemetry schema.

The original isolated one-minute admission lanes remain `RATE_LIMIT_PROCESS`, `RATE_LIMIT_EXPORT`, `RATE_LIMIT_TRANSLATE`, `RATE_LIMIT_VOICE`, and `RATE_LIMIT_UPLOAD`; later feature-specific lanes are additive. Authorization/input validation precedes limiter consumption and expensive side effects.

Export sharing remains owner-managed and revocable. Invalid, missing, expired, revoked, and wrong-token anonymous access converges on `SHARE_NOT_FOUND`. The historical manual-only GitHub production lane remains removed. Production provider/media runtime status remains **UNQUALIFIED** until real fixture verification.

## Phase 4A translation context qualification

Phase 4A translation context remains **source-qualified only**. Project style/glossary settings are revision-safe and owner scoped. The contextual model runtime is not proven by source CI; runtime status remains **UNQUALIFIED**.

## Phase 4A project-stable diarization qualification

The current zero-container source sends a signed R2 media URL directly to remote ASR without the removed FFmpeg chunk-extraction runtime. Conservative deterministic speaker reconciliation and safe historical speaker-ID reuse remain in place; no biometric embedding or voiceprint store is introduced.

The former 300-second / 15-second overlapping FFmpeg chunk contract is historical, not the active source path. Production runtime remains **UNQUALIFIED** until a real R2/ASR fixture proves persisted speaker linkage and rerun safety.

## Phase 4B safe managed voice clone qualification

Phase 4B remains **source/CI qualification only** for consent-gated ElevenLabs Instant Voice Clone enrollment. Explicit rights/consent is required. Temporary samples remain bounded and managed cleanup is fail-closed. Production runtime remains **UNQUALIFIED** until a real authorized sample fixture passes.

## Phase 4C multi-language batch export qualification

Phase 4C remains **source/CI qualification only** for `vi`, `en`, `ja`, `ko`, and `zh`. Target translations, voice artifacts, soundtracks and exports are persisted independently; Vietnamese backward compatibility remains intact without overwriting sibling targets.

`RATE_LIMIT_BATCH_EXPORT` remains the dedicated batch admission lane. Batch grouping is metadata only; child `project_exports` rows remain authoritative, so one failed target does not roll back completed siblings. The R2-only PCM/WAV + MP4 remux publisher is the active `dubbed_only` render path.

Production multi-language runtime remains **UNQUALIFIED** until a real authorized fixture proves at least two target languages through translation, TTS, soundtrack assembly, R2 MP4 remux, retrieval and concrete export sharing.

## Phase 4D hybrid audio treatment qualification

Phase 4D retains the API/source vocabulary `dubbed_only`, `duck_original`, and `separated_background`. In the approved zero-container production architecture, `dubbed_only` uses PCM/WAV plus R2 MP4 remux. `duck_original` and `separated_background` remain intentionally fail-closed because no qualified zero-container equivalent is wired.

Migration `0011_phase4d_audio_separation.sql` introduced source generation, audio mode and stem state. There is no silent downgrade from a requested hybrid mode to `dubbed_only`. Runtime remains **UNQUALIFIED** for the unavailable modes.

## Phase 4E optional visual lip-sync qualification

Phase 4E is **source/CI qualification only** for optional Sync Labs visual lip-sync. The already-applied migrations `0012_visual_lipsync.sql` and `0012_stream_media.sql` deliberately retain their original filenames for production D1 ledger compatibility. Legacy Stream columns are tolerated as historical nullable state; new R2-only jobs do not depend on them. Their structural schema participates in readiness revision **14** without replaying either migration.

The visual provider receives a bounded HTTPS grant for the standard MP4 and a second bounded grant for `projects/{projectId}/soundtracks/{targetLanguage}/{exportId}.wav`. A successful result is stored separately as `.lipsync.mp4`. Provider failures do not destroy or relabel the already-completed standard MP4.

Sync Labs remains optional and production runtime remains **UNQUALIFIED** until a real supported provider/media fixture completes end-to-end. `SYNC_API_KEY` configures the provider only; visual admission remains fail-closed unless `SYNC_LIPSYNC_QUALIFIED=true` is set after that real supported end-to-end fixture has been qualified.

## Studio reference qualification

Studio CI captures the canonical reference viewports from the exact tested SHA. Screenshots qualify presentation only. Durable dubbing/export state is surfaced in the UI so queued/running/error state does not appear as an inert action.

## Deployment verification

Safe rollout order:

1. Merge an exact fully-green commit to `main`.
2. Let Cloudflare Workers Builds deploy the backend account from that exact main commit and apply pending D1 migrations.
3. Verify backend `/api/ready` reports database ready, exact schema revision 14, `media.r2: "ready"`, and `media.remux: "ready"`.
4. Verify the gateway points at the intended backend and `https://yupvox.qs3d.site/api/ready` returns the same current state.
5. Run a real small H.264 MP4 upload -> dubbing -> standard export fixture and verify the final R2 MP4 plays through the public gateway without Containers or Stream.
6. Only after that live qualification remove any obsolete Stream control-plane secret/binding and retire the temporary signing-secret alias in a later bounded cleanup.

A GREEN CI run, screenshot, Wrangler dry-run, or successful deploy alone does not upgrade paid/external provider runtime qualification. GitHub Actions remains CI only.
