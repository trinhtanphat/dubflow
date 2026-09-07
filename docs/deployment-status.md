# YupVox deployment status

Canonical public hostname: `yupvox.qs3d.site`

## Current Cloudflare topology

Production uses a split Cloudflare topology.

- Public zone/gateway account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`. It owns `qs3d.site`, the `yupvox.qs3d.site` custom domain, TLS, and the thin `dubflow-gateway` Worker.
- Backend/state account: `6c5207813df3d5b83b9508125e0e9e12`. It owns the `dubflow` backend Worker and persisted production data in D1/R2 together with Workers AI, Analytics Engine, Workflows, rate-limit resources, and the media provider state used by the backend.

The gateway owns no DubFlow database or media state. It forwards the public hostname to the configured backend origin. `main` remains the repository source of truth. GitHub Actions is CI only and **must not deploy production**. Cloudflare Workers Builds is the backend deployment lane; gateway deployment is defined by `wrangler.gateway.jsonc`.

## Containers disabled

Cloudflare **Containers are disabled in production**. The current production source does not deploy `FFMPEG_CONTAINER`, `SEPARATOR_CONTAINER`, Container-backed Durable Objects, or `@cloudflare/containers`.

The FFmpeg Container runtime has been removed from the active dubbing and `dubbed_only` export path. Historical FFmpeg/Demucs material does not imply a deployed Container. Hybrid audio modes that still need an unimplemented media treatment remain fail-closed instead of silently falling back.

## Current zero-container source path

The current zero-container source path is: R2 multipart upload -> Cloudflare Stream source preparation -> remote ASR (Deepgram when configured, bounded Workers AI fallback where admitted) -> speaker reconciliation -> translation -> per-speaker ElevenLabs TTS -> Worker-native PCM/WAV soundtrack assembly -> Cloudflare Stream dubbed MP4 publishing.

Migration `0012_visual_lipsync.sql` keeps its historical filename because production D1 already recorded that exact migration name before the zero-container Stream rollout. Migration `0012_stream_media.sql` is a separate forward migration that persists Stream source and per-export render provenance. Wrangler tracks the full migration filename, so both `0012_*` files remain distinct; renaming the already-applied visual migration would cause D1 to replay its schema changes. The combined readiness contract is schema revision **13**, determined by structural schema checks rather than the numeric filename prefix. The deployment verifier rejects stale HTTP-200 payloads that do not report exact revision 13.

Canonical target artifacts include:

- voice clips: `projects/{projectId}/voices/{targetLanguage}/...`
- soundtrack: `projects/{projectId}/soundtracks/{targetLanguage}/{exportId}.wav`
- subtitles: `projects/{projectId}/subtitles/{targetLanguage}/{exportId}.srt`
- standard dubbed export: `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`
- optional visual result: `projects/{projectId}/exports/{targetLanguage}/{exportId}.lipsync.mp4`

Visual lip-sync does **not** re-extract export audio with FFmpeg. Sync Labs receives the already-rendered standard MP4 plus the durable PCM/WAV soundtrack through bounded provider-media grants. Standard MP4 publication completes first and remains durable even if the optional visual operation fails.

Stream write/signing configuration is required for dubbed export. `SYNC_API_KEY` is optional: when absent, standard zero-container dubbing/export stays available while visual lip-sync admission reports unavailable. Secret values are never committed. Source CI does not claim a real external provider is configured.

## Phase 3B usage qualification

Phase 3B keeps the durable idempotent usage ledger authoritative for ASR, translation, generated TTS audio, final render, and optional visual lip-sync usage. Persisted/API units remain seconds for ASR/TTS/render/lip-sync and Unicode source characters for translation. Retry/provider operation identity prevents Workflow replay from duplicating the same logical completed provider work. `users.credit_balance` remains informational/read-only.

## Phase 3C observability, rate-limit, and sharing qualification

Phase 3C source/CI qualification uses the `dubflow_events` Analytics Engine dataset and bounded operational telemetry. Payloads, transcripts, media contents, raw bearer tokens and provider secrets remain outside the telemetry schema.

The original isolated one-minute admission lanes remain `RATE_LIMIT_PROCESS`, `RATE_LIMIT_EXPORT`, `RATE_LIMIT_TRANSLATE`, `RATE_LIMIT_VOICE`, and `RATE_LIMIT_UPLOAD`; later feature-specific lanes are additive. Authorization/input validation precedes limiter consumption and expensive side effects.

Export sharing remains owner-managed and revocable. Invalid, missing, expired, revoked, and wrong-token anonymous access converges on `SHARE_NOT_FOUND`. The historical manual-only GitHub production lane remains removed. Production provider/media runtime status remains **UNQUALIFIED** until real fixture verification.

## Phase 4A translation context qualification

Phase 4A translation context remains **source-qualified only**. Project style/glossary settings are revision-safe and owner scoped. The contextual model runtime is not proven by source CI; runtime status remains **UNQUALIFIED**.

## Phase 4A project-stable diarization qualification

The current zero-container source prepares a Stream media source and sends remote ASR without the removed FFmpeg chunk-extraction runtime. Conservative deterministic speaker reconciliation and safe historical speaker-ID reuse remain in place; no biometric embedding or voiceprint store is introduced.

The former 300-second / 15-second overlapping FFmpeg chunk contract is historical, not the active source path. Production runtime remains **UNQUALIFIED** until a real Stream/ASR fixture proves persisted speaker linkage and rerun safety.

## Phase 4B safe managed voice clone qualification

Phase 4B remains **source/CI qualification only** for consent-gated ElevenLabs Instant Voice Clone (IVC) enrollment. Explicit rights/consent is required. Temporary samples remain bounded and managed cleanup is fail-closed. Production runtime remains **UNQUALIFIED** until a real authorized sample fixture passes.

## Phase 4C multi-language batch export qualification

Phase 4C remains **source/CI qualification only** for `vi`, `en`, `ja`, `ko`, and `zh`. Target translations, voice artifacts, soundtracks and exports are persisted independently; Vietnamese backward compatibility remains intact without overwriting sibling targets.

`RATE_LIMIT_BATCH_EXPORT` remains the dedicated batch admission lane. Batch grouping is metadata only; child `project_exports` rows remain authoritative, so one failed target does not roll back completed siblings. The zero-container PCM/WAV + Stream publisher is the active `dubbed_only` render path.

Production multi-language runtime remains **UNQUALIFIED** until a real authorized fixture proves at least two target languages through translation, TTS, soundtrack assembly, Stream publishing, retrieval and concrete export sharing.

## Phase 4D hybrid audio treatment qualification

Phase 4D retains the API/source vocabulary `dubbed_only`, `duck_original`, and `separated_background`. In the approved zero-container production architecture, `dubbed_only` is implemented by PCM/WAV + Stream. `duck_original` and `separated_background` remain intentionally fail-closed because no qualified zero-container equivalent is wired.

Migration `0011_phase4d_audio_separation.sql` introduced source generation, audio mode and stem state. There is no silent downgrade from a requested hybrid mode to `dubbed_only`. Runtime remains **UNQUALIFIED** for the unavailable modes.

## Phase 4E optional visual lip-sync qualification

Phase 4E is **source/CI qualification only** for optional Sync Labs visual lip-sync. The already-applied migration `0012_visual_lipsync.sql` deliberately retains its original filename for production D1 ledger compatibility. The new Stream migration is `0012_stream_media.sql`; together their resulting structural schema satisfies readiness revision **13** without replaying the historical visual migration.

The visual provider receives a bounded HTTPS grant for the standard MP4 and a second bounded grant for `projects/{projectId}/soundtracks/{targetLanguage}/{exportId}.wav`. A successful result is stored separately as `.lipsync.mp4`. Provider failures do not destroy or relabel the already-completed standard MP4.

Sync Labs remains optional and production runtime remains **UNQUALIFIED** until a real supported provider/media fixture completes end-to-end. `SYNC_API_KEY` configures the provider only; visual admission remains fail-closed unless `SYNC_LIPSYNC_QUALIFIED=true` is set after that real supported end-to-end fixture has been qualified.

## Studio reference qualification

Studio CI captures the canonical reference viewports from the exact tested SHA. Screenshots qualify presentation only. Durable dubbing/export state is surfaced in the UI so queued/running/error state does not appear as an inert action.

## Deployment verification

Safe rollout order:

1. Merge an exact fully-green commit to `main`.
2. Let Cloudflare Workers Builds deploy the backend account from that exact main commit and apply pending D1 migrations.
3. Verify backend `/api/ready` reports database ready and exact schema revision 13 with Stream readiness.
4. Verify the gateway points at the intended backend and `https://yupvox.qs3d.site/api/ready` returns the same current state.

A GREEN CI run, screenshot, Wrangler dry-run, or successful deploy alone does not upgrade paid/external provider runtime qualification. GitHub Actions remains CI only.
