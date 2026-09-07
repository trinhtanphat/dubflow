# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare production account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`

That account owns the live `yupvox.qs3d.site` custom domain and the persisted production projects/data. A separate Cloudflare account also contains a Worker named `dubflow`, but it does not own the public hostname or the four production projects and is not the canonical production target.

Production deployment topology is intentionally simple: `main` is the only production source of truth. GitHub Actions is CI only. The old **manual-only** GitHub production deployment workflow has been removed. Cloudflare Workers Builds watches `main`; when `main` changes, Cloudflare automatically builds and deploys production from that commit. The repository-level rule is documented in `docs/DEPLOYMENT-POLICY.md`.

On 2026-09-06 the public production incident was traced to account drift: repository/Workers Builds configuration targeted the second account while the custom domain and persisted D1 data remained on the canonical production account. The canonical D1 was backed up, migrated through `0010_multilanguage_variants.sql`, and the exact qualified main source was deployed in place. Live qualification then passed with `/api/ready` reporting `schemaRevision: 10`, `/api/projects` returning the four persisted projects, `/api/usage` returning HTTP 200, and the two previously failing project detail reads returning HTTP 200. That is historical live evidence, not a claim that the zero-container source described below has already deployed. Repository guards pin the account topology and reject stale HTTP-200 readiness responses that lack the exact current source schema revision.

## Current zero-container source path

The current source path uses R2 multipart upload, durable Cloudflare Workflow jobs, Cloudflare Stream source preparation, Deepgram remote ASR (with the bounded direct Workers AI fallback only where admitted), conservative project-stable speaker reconciliation, context-aware translation, server-backed transcript/speaker editing, consent-gated managed ElevenLabs IVC enrollment, per-speaker TTS, Worker-native PCM/WAV soundtrack assembly, and Cloudflare Stream publishing for dubbed MP4 output. The FFmpeg Container runtime has been removed from the current dubbing and `dubbed_only` export path; there is no `FFMPEG_CONTAINER` binding, Durable Object media proxy, or `@cloudflare/containers` dependency in the production source.

Migration `0012_stream_media.sql` advances the source readiness contract to schema revision **12** and persists Stream provenance. The deployment verifier also requires exact schema revision 12, so a stale schema-10 or schema-11 HTTP 200 response cannot qualify this source after merge.

Google Translation, Deepgram, ElevenLabs and the contextual translation model remain optional configured provider paths. Stream write/signing configuration is required for dubbed export. Secret values are never committed. Real provider availability is not inferred from source CI.

## Phase 3B usage qualification

Phase 3B source/CI qualification keeps the durable, idempotent internal usage ledger authoritative for ASR, translation, generated TTS audio and final render. Persisted/API units are seconds for ASR/TTS/render and Unicode source characters for translation. Durable retry/provider operation identity and `(operation_key, phase)` prevent Workflow replay from duplicating the same logical started/completed event.

`users.credit_balance` remains informational/read-only. Phase 3B does not price, decrement, reserve or sell credits. The current Stream remote-ASR path meters the actual provider audio duration once for the prepared source; speaker reconciliation does not rewrite those usage events.

## Phase 3C observability, rate-limit, and sharing qualification

Phase 3C source/CI qualification uses the `dubflow_events` Analytics Engine dataset and bounded operational telemetry. Payloads, transcripts, media content, provider secrets, raw bearer tokens and raw URLs are outside the telemetry schema.

The five original isolated one-minute admission lanes remain present and unchanged: `RATE_LIMIT_PROCESS`, `RATE_LIMIT_EXPORT`, `RATE_LIMIT_TRANSLATE`, `RATE_LIMIT_VOICE`, and `RATE_LIMIT_UPLOAD`. Authorization and relevant input validation precede limiter consumption and expensive side effects. These controls do not write usage or billing state.

Export sharing remains owner-managed and revocable. Plaintext bearer tokens are returned only on creation while D1 stores the SHA-256 hash and a non-secret hint. Invalid, missing, expired, revoked and wrong-token anonymous access converges on `SHARE_NOT_FOUND`. Owner and anonymous media reads use the common Range implementation and retain 200/206/416 behavior. Public responses preserve `Referrer-Policy: no-referrer`.

Production API/schema deployment is live-qualified only for the last explicitly verified deployed revision, while provider/media runtime behavior remains **UNQUALIFIED** until the documented real provider/media fixture gates pass.

## Phase 4A translation context qualification

Phase 4A translation context is **source-qualified only**. Project style/glossary settings are revision-safe and owner scoped, and each contextual translation operation uses one immutable context snapshot. Raw Workers AI/Google provider paths do not silently claim contextual support.

The contextual model runtime is not proven by source CI. Production runtime status remains **UNQUALIFIED**.

## Phase 4A project-stable diarization qualification

The current zero-container source prepares one Stream media source and submits one zero-overlap logical ASR input to the speaker-stitch/reconciliation layer. Deterministic duplicate suppression, conservative speaker stitching and safe historical speaker-ID reconciliation remain in place; ambiguous evidence remains split and no biometric embedding, voiceprint or biometric template store is introduced.

The prior 300-second / 15-second overlapping ASR chunk contract is historical and is no longer the active production source path. Phase 3B meters the actual audio duration submitted to the current ASR provider. Production runtime remains **UNQUALIFIED** until a real Deepgram/Stream fixture proves persisted speaker linkage and safe rerun reconciliation.

## Phase 4B safe managed voice clone qualification

Phase 4B is **source/CI qualification only** for managed ElevenLabs Instant Voice Clone (IVC) enrollment. Explicit rights/consent is required before enrollment; project ownership, a diarized speaker, source media, a display name or an existing voice assignment never implies consent. YupVox does not auto-extract source-video speech for cloning.

Temporary user-supplied samples are bounded and cleaned from R2 after provider attempts. Only a durable `ready` clone may be assigned. Provider/sample cleanup failures remain fail-closed, and managed deletion does not claim success before required provider/local cleanup succeeds. `RATE_LIMIT_VOICE_CLONE` is additive abuse control and not billing state.

Production runtime remains **UNQUALIFIED** for managed IVC until a real authorized sample/consent fixture proves enrollment, state handling, assignment, cleanup and provider deletion. Production deployment itself is automatic through Cloudflare Workers Builds after `main` changes.

## Phase 4C multi-language batch export qualification

Phase 4C is **source/CI qualification only** for bounded **multi-language** dubbing/export across exactly `vi`, `en`, `ja`, `ko`, and `zh`. Project target configuration keeps Vietnamese available for backward compatibility, while each batch request admits one to four distinct supported targets. Unsupported languages fail before limiter consumption, Workflow creation, provider calls, usage writes or durable media mutation.

Target translations, dubbed audio and export variants are persisted independently. Target voice artifacts are scoped under `projects/{projectId}/voices/{targetLanguage}/...`; subtitle artifacts are scoped under `projects/{projectId}/subtitles/{targetLanguage}/{exportId}.srt`; dubbed export artifacts remain scoped under `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`. Dubbed variants use the zero-container PCM/Stream publisher and retain concrete target/export identity rather than overwriting sibling targets. Non-Vietnamese work never overwrites legacy Vietnamese fields; a completed `vi` target variant alone may mirror into `projects.export_object_key`.

Batch orchestration fans out independent child export records. `batch_id` is grouping metadata only; there is no separate persisted batch authority. Aggregate progress/status is derived from the child `project_exports` rows, so one failed/cancelled target does not roll back a completed sibling. Translation/TTS/render work continues to use Phase 3B usage accounting with target-specific idempotency identity. `RATE_LIMIT_BATCH_EXPORT` is an additive `2/min` abuse/admission lane and does not create pricing, credits or batch billing semantics.

Owner downloads can select a concrete completed export variant. New multi-language shares bind to a concrete `export_id` and keep the pinned export identity; legacy share creation without an explicit export id remains Vietnamese-compatible. Existing 256-bit bearer-token hashing, one-time URL handling, expiry, revocation, no-referrer protection and 200/206/416 Range behavior remain unchanged where R2-backed media is used.

A GREEN Phase 4C source/CI run and Wrangler dry-run do not prove real multi-language production behavior. Production runtime remains **UNQUALIFIED** until a real authorized provider/media fixture demonstrates at least two distinct targets end-to-end through translation, target-language ElevenLabs TTS, PCM/WAV assembly, Stream publishing, persisted export variants, owner retrieval and concrete-variant sharing. A successful deployment by itself is not that fixture.

Merging Phase 4C or later fixes to `main` triggers Cloudflare Workers Builds automatically. There is no separate GitHub production deploy action. Runtime qualification remains fail-closed on real Cloudflare/provider/media evidence even though deployment is automatic.

## Phase 4D hybrid audio treatment qualification

Phase 4D retains the exact API/source audio-mode vocabulary `dubbed_only`, `duck_original`, and `separated_background`; omitted mode remains backward-compatible `dubbed_only`. In the approved zero-container production architecture, only `dubbed_only` is wired to the PCM/Stream publisher. The legacy hybrid render modes are intentionally fail-closed rather than silently degrading to another treatment.

The historical `duck_original` contract used deterministic -18 dB dialogue attenuation with an 80 ms lead and 120 ms tail before mixing dubbed clips. That FFmpeg-based renderer is no longer part of the current production source. `separated_background` also remains unavailable/unqualified: production intentionally wires `UnavailableDialogueSeparationProvider`, and Studio capability admission must not claim a qualified separation runtime.

Migration `0011_phase4d_audio_separation.sql` introduced project `source_generation`, export `audio_mode`, and owner-scoped `project_audio_stems`; migration `0012_stream_media.sql` then advances the current source readiness target to schema revision **12** with Stream provenance. Source replacement continues to protect generation-scoped state from stale reuse.

There is no silent downgrade from `duck_original` or `separated_background` to `dubbed_only`. A future implementation of either hybrid mode must satisfy the zero-container architecture or go through a new explicitly approved design and real-media qualification lane. Until then these modes remain fail-closed and production runtime remains **UNQUALIFIED**.

## Studio reference qualification

Studio CI continues to capture the canonical desktop/reference viewports from the exact tested SHA. Reference screenshots qualify presentation, not real provider/media runtime behavior. Empty-media states remain truthful rather than fabricating uploaded footage. Durable dubbing job state is surfaced in the upload panel so queued/running stage, progress, and provider errors do not disappear behind an apparently inert button.

## Qualification status

The last explicitly recorded live API/schema evidence in this document is the 2026-09-06 recovery at schema revision 10. The current branch/source target is schema revision **12**; it must not be called live-qualified until the branch is merged, Cloudflare Workers Builds applies the pending migrations/configuration, and public `/api/ready` reports exact revision 12 with Stream readiness. A GREEN source CI and Wrangler dry-run qualify repository source/configuration only. GitHub Actions remains CI only and must not deploy production.

Final provider/media runtime qualification still requires real supported fixtures: Deepgram/Stream for source ASR and speaker reconciliation, configured contextual translation for style/glossary behavior, ElevenLabs plus PCM/Stream for final dubbed export, an authorized IVC sample for cloning, and for Phase 4C at least two distinct supported target languages through translation, TTS, publish, retrieval and concrete export sharing. `duck_original` and `separated_background` remain intentionally unavailable in the current zero-container production path. Until live rollout and the applicable provider fixtures succeed, those runtime capabilities remain **UNQUALIFIED** rather than PASS.
