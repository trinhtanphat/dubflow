# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`

Production deployment topology is intentionally simple: `main` is the only production source of truth. GitHub Actions is CI only. The old **manual-only** GitHub production deployment workflow has been removed. Cloudflare Workers Builds watches `main`; when `main` changes, Cloudflare automatically builds and deploys the Worker/Static Assets/FFmpeg Container from that commit. The repository-level rule is documented in `docs/DEPLOYMENT-POLICY.md`.

A previous Cloudflare Workers Build reached Worker upload and Container image build but returned `Unauthorized` while Wrangler moved into Container deployment. That failure does not create a second deployment lane: fixes belong in repository/configuration or the Cloudflare build environment, then get committed and merged to `main` so Cloudflare Workers Builds retries through the normal automatic flow.

## Reconciled live dubbing source path

The source path includes R2 multipart upload, durable Cloudflare Workflow jobs, FFmpeg Container media processing, Deepgram/Workers AI ASR, conservative project-stable diarization reconciliation, context-aware translation, server-backed transcript/speaker editing, consent-gated managed ElevenLabs IVC enrollment, per-speaker ElevenLabs TTS, FFmpeg dubbed-audio timeline rendering, and final R2 export artifacts.

Google Translation, Deepgram, ElevenLabs and the contextual translation model remain optional configured provider paths. Secret values are never committed. Real provider availability is not inferred from source CI.

## Phase 3B usage qualification

Phase 3B source/CI qualification keeps the durable, idempotent internal usage ledger authoritative for ASR, translation, generated TTS audio and final render. Persisted/API units are seconds for ASR/TTS/render and Unicode source characters for translation. Durable retry/provider operation identity and `(operation_key, phase)` prevent Workflow replay from duplicating the same logical started/completed event.

`users.credit_balance` remains informational/read-only. Phase 3B does not price, decrement, reserve or sell credits. Overlapping Phase 4A ASR windows meter the actual provider audio duration including overlap; deduplication does not rewrite those usage events.

## Phase 3C observability, rate-limit, and sharing qualification

Phase 3C source/CI qualification uses the `dubflow_events` Analytics Engine dataset and bounded operational telemetry. Payloads, transcripts, media content, provider secrets, raw bearer tokens and raw URLs are outside the telemetry schema.

The five original isolated one-minute admission lanes remain present and unchanged: `RATE_LIMIT_PROCESS`, `RATE_LIMIT_EXPORT`, `RATE_LIMIT_TRANSLATE`, `RATE_LIMIT_VOICE`, and `RATE_LIMIT_UPLOAD`. Authorization and relevant input validation precede limiter consumption and expensive side effects. These controls do not write usage or billing state.

Export sharing remains owner-managed and revocable. Plaintext bearer tokens are returned only on creation while D1 stores the SHA-256 hash and a non-secret hint. Invalid, missing, expired, revoked and wrong-token anonymous access converges on `SHARE_NOT_FOUND`. Owner and anonymous media reads use the common Range implementation and retain 200/206/416 behavior. Public responses preserve `Referrer-Policy: no-referrer`.

This remains source/configuration qualification. Production deployment is performed automatically by Cloudflare Workers Builds after `main` changes, while runtime status remains **UNQUALIFIED** until the documented deployment and real provider/media fixture gates pass.

## Phase 4A translation context qualification

Phase 4A translation context is **source-qualified only**. Project style/glossary settings are revision-safe and owner scoped, and each contextual translation operation uses one immutable context snapshot. Raw Workers AI/Google provider paths do not silently claim contextual support.

The contextual model runtime is not proven by source CI. Production runtime status remains **UNQUALIFIED**.

## Phase 4A project-stable diarization qualification

Phase 4A source/CI qualification uses bounded 300-second ASR windows with a 15-second overlap. The canonical next-window stride is **285 seconds** (`300 − 15`), preserving the superseding fixed overlap contract. Duplicate suppression, conservative cross-window speaker stitching and safe historical speaker-ID reconciliation remain deterministic; ambiguous evidence remains split and no biometric embedding, voiceprint or biometric template store is introduced.

Phase 3B still meters the actual audio sent to the ASR provider. Production runtime remains **UNQUALIFIED** until a real Deepgram/media fixture proves cross-window persisted speaker linkage and safe rerun reconciliation.

## Phase 4B safe managed voice clone qualification

Phase 4B is **source/CI qualification only** for managed ElevenLabs Instant Voice Clone (IVC) enrollment. Explicit rights/consent is required before enrollment; project ownership, a diarized speaker, source media, a display name or an existing voice assignment never implies consent. YupVox does not auto-extract source-video speech for cloning.

Temporary user-supplied samples are bounded and cleaned from R2 after provider attempts. Only a durable `ready` clone may be assigned. Provider/sample cleanup failures remain fail-closed, and managed deletion does not claim success before required provider/local cleanup succeeds. `RATE_LIMIT_VOICE_CLONE` is additive abuse control and not billing state.

Production runtime remains **UNQUALIFIED** for managed IVC until a real authorized sample/consent fixture proves enrollment, state handling, assignment, cleanup and provider deletion. Production deployment itself is automatic through Cloudflare Workers Builds after `main` changes.

## Phase 4C multi-language batch export qualification

Phase 4C is **source/CI qualification only** for bounded **multi-language** dubbing/export across exactly `vi`, `en`, `ja`, `ko`, and `zh`. Project target configuration keeps Vietnamese available for backward compatibility, while each batch request admits one to four distinct supported targets. Unsupported languages fail before limiter consumption, Workflow creation, provider calls, usage writes or durable media mutation.

Target translations, dubbed audio and export variants are persisted independently. Target voice artifacts are scoped under `projects/{projectId}/voices/{targetLanguage}/...`; subtitle artifacts are scoped under `projects/{projectId}/subtitles/{targetLanguage}/{exportId}.srt`; and completed dubbed exports are scoped under `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`. Non-Vietnamese work never overwrites legacy Vietnamese fields; a completed `vi` target variant alone may mirror into `projects.export_object_key`.

Batch orchestration fans out independent child export records. `batch_id` is grouping metadata only; there is no separate persisted batch authority. Aggregate progress/status is derived from the child `project_exports` rows, so one failed/cancelled target does not roll back a completed sibling. Translation/TTS/render work continues to use Phase 3B usage accounting with target-specific idempotency identity. `RATE_LIMIT_BATCH_EXPORT` is an additive `2/min` abuse/admission lane and does not create pricing, credits or batch billing semantics.

Owner downloads can select a concrete completed export variant. New multi-language shares bind to a concrete `export_id` and keep the pinned export object key; legacy share creation without an explicit export id remains Vietnamese-compatible. Existing 256-bit bearer-token hashing, one-time URL handling, expiry, revocation, no-referrer protection and 200/206/416 Range behavior remain unchanged.

A GREEN Phase 4C source/CI run and Wrangler dry-run do not prove real multi-language production behavior. Production runtime remains **UNQUALIFIED** until a real authorized provider/media fixture demonstrates at least two distinct targets end-to-end through translation, target-language ElevenLabs TTS, target-scoped FFmpeg rendering, persisted export variants, owner retrieval and concrete-variant sharing. A successful deployment by itself is not that fixture.

Merging Phase 4C or later fixes to `main` triggers Cloudflare Workers Builds automatically. There is no separate GitHub production deploy action. Runtime qualification remains fail-closed on real Cloudflare/provider/media evidence even though deployment is automatic.

## Studio reference qualification

Studio CI continues to capture the canonical desktop/reference viewports from the exact tested SHA. Reference screenshots qualify presentation, not real provider/media runtime behavior. Empty-media states remain truthful rather than fabricating uploaded footage.

## Qualification status

A GREEN source CI and Wrangler dry-run qualify repository source/configuration only. Production deployment is automatic through Cloudflare Workers Builds whenever `main` changes; GitHub Actions remains CI only and must not deploy production.

Final runtime qualification still requires the deployed application and real supported media/provider fixtures: Deepgram for diarization, configured contextual translation for style/glossary behavior, ElevenLabs/FFmpeg for final export, an authorized IVC sample for cloning, and for Phase 4C at least two distinct supported target languages through translation, TTS, render, retrieval and concrete export sharing. Until those live fixtures succeed, runtime status remains **UNQUALIFIED** rather than PASS.
