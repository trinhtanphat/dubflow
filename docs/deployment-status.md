# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`

Deployment is fail-closed. `npm run deploy` verifies source, runs a Wrangler dry run, deploys the Worker and Static Assets, applies D1 migrations by binding, and only reports success after `/api/ready` confirms the production schema exists.

GitHub Actions is enabled for this public repository. CI runs real dependency installation, tests, TypeScript/Vite build, a Wrangler dry-run, and captures a 1448×1086 headless Chromium screenshot from the exact tested SHA for Studio reference qualification. Production deployment is **manual-only** via `workflow_dispatch` while the Cloudflare Container credential is externally qualified. It requires the `CLOUDFLARE_API_TOKEN` GitHub secret. Because this deployment builds and pushes an FFmpeg Cloudflare Container, the token must include Cloudflare's **Containers Write** (or equivalent Containers Edit) permission in addition to the permissions needed for Workers and bound resources. The Cloudflare account ID is non-secret and pinned to the canonical account above.

The first live Container deploy attempt on the reconciled source proved the existing token can reach the Worker deployment path but returned `Unauthorized` when Wrangler moved into the Container image deployment. Until the token is replaced or updated with the required Container permission, do not treat production runtime as qualified and do not repeatedly auto-deploy `main`.

## Reconciled live dubbing source path

The current source implements:

```text
R2 multipart media upload
-> durable Cloudflare Workflow job
-> FFmpeg Cloudflare Container probe + bounded 300-second audio chunks with 15-second overlap
-> Deepgram Nova-3 diarized ASR when DEEPGRAM_API_KEY is configured
   OR Workers AI Whisper fallback when it is absent
-> deterministic adjacent-chunk overlap dedupe + conservative project-stable speaker stitching
-> safe rerun reconciliation against existing project speaker coverage
-> deterministic/atomic D1 speaker + transcript persistence
-> Workers AI translation by default
-> project/job terminal state
-> Studio poll + transcript/timeline/speaker metadata hydration
-> server-backed transcript editing, speaker naming and per-speaker ElevenLabs voice assignment
-> ElevenLabs segment TTS using the assigned speaker voice when present
-> FFmpeg dubbed-audio timeline assembly/mux
-> final R2 export artifact
```

Deepgram diarization remains chunk-local at the provider boundary, but Phase 4A now reconciles adjacent chunk-local speaker indexes into conservative project-stable speaker identities when duplicate overlap evidence is strong and unambiguous. Ambiguous boundaries deliberately remain separate instead of forcing a potentially incorrect identity merge. Workers AI Whisper fallback remains undiarized and persists `speakerId = null` rather than fabricating an identity.

Per-speaker voice assignment is persisted on the existing D1 `speakers` records. Changing a speaker voice invalidates that speaker's previously generated dubbed segment audio plus any published project export before the next render; renaming a speaker does not discard valid audio. Missing per-speaker voice IDs continue to use the configured ElevenLabs default voice rather than fabricating an assignment.

Google Translation remains an optional configured provider. Compare mode does not persist a winner until the user explicitly applies it. Deepgram is also optional: without `DEEPGRAM_API_KEY`, the source falls back to Workers AI Whisper and `/api/ready` reports speaker diarization as unavailable while the base service can remain ready.

The deploy workflow supports optional `GOOGLE_CLOUD_TRANSLATE_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_DEFAULT_VOICE_ID` GitHub secrets and syncs configured values into Worker secrets without committing them.

Source support for final dubbed export now exists through the ElevenLabs + FFmpeg export workflow, including source-level per-speaker voice routing. This is still distinct from production-runtime qualification: the repository must not claim a deployed export PASS until a real fixture produces and returns the final artifact. Voice cloning and visual lip-sync rendering remain capability-gated and unqualified.

## Phase 3B usage qualification

Phase 3B source/CI qualification adds a durable, idempotent internal usage ledger for ASR, translation, generated TTS audio, and final render. Canonical persisted/API units are seconds for ASR/TTS/render and Unicode source characters for translation. Usage operation identity includes durable job retry generation and provider, and `(operation_key, phase)` prevents automatic Workflow replay from duplicating the same logical started/completed event.

Authorized summaries are exposed through `GET /api/usage` and `GET /api/projects/:id/usage`. Project usage remains ownership-scoped and cross-user/missing project access is hidden behind a 404. The dashboard shows informational account usage and provider breakdown while keeping usage loading/errors isolated from project/job loading.

`users.credit_balance` remains informational/read-only, and Phase 3B does not decrement, reserve, price, enforce, or sell credits. `cost_basis` remains zero. There is no payment UI, upgrade CTA, quota enforcement, provider price table, rate-limit policy, observability policy, or public sharing control in this phase.

A GREEN Phase 3B acceptance gate qualifies repository source behavior only. It does **not** change the production-runtime status below: the Cloudflare Container credential and real provider/media fixture gates must still pass before runtime can be called qualified.

## Phase 3C observability, rate-limit, and sharing qualification

Phase 3C source/CI qualification adds Cloudflare-native operational telemetry and admission controls without turning them into billing or quota accounting. `ANALYTICS` is bound to the `dubflow_events` Analytics Engine dataset, invocation logs are enabled, query strings are redacted, and Worker traces use a 5% head-sampling rate. Telemetry remains bounded to opaque identifiers, operation/provider/status metadata, HTTP status and latency; transcript/media payloads, provider secrets, bearer tokens and raw URLs are outside the telemetry schema.

Five independent Cloudflare Rate Limiting bindings protect expensive operations with server-derived actor keys and one-minute windows: `RATE_LIMIT_PROCESS` is `4/min`, `RATE_LIMIT_EXPORT` is `4/min`, `RATE_LIMIT_TRANSLATE` is `30/min`, `RATE_LIMIT_VOICE` is `30/min`, and `RATE_LIMIT_UPLOAD` is `20/min`. Authorization/ownership and relevant input validation happen before the limiter is consumed; a denial returns HTTP 429 with stable `RATE_LIMITED` semantics and `Retry-After: 60` before jobs, Workflows, providers, multipart creation, usage writes, or project-state mutation. These counters are abuse/admission controls only: Phase 3C rate limiting and telemetry do not write `usage_events`, decrement `credit_balance`, establish pricing, or create a payment/quota system.

Final exported media can be shared through owner-managed, revocable links. Owners can create, list and revoke share records; plaintext bearer tokens are returned only in the create response, while D1 persists only a unique SHA-256 token hash plus a short non-secret hint. Share secrets are generated from 32 cryptographically random bytes. Share expiry is bounded from one hour to 30 days and the Studio defaults to seven days. Anonymous shared media requires both share ID and token; invalid, unknown, expired, revoked, and wrong-token access all converge on `404 SHARE_NOT_FOUND`. Owner and shared downloads use the same byte-range streaming path for 200/206/416 semantics, and public share responses send `Referrer-Policy: no-referrer` so the bearer-token URL is not leaked through browser referrers. Owner listings never reconstruct or return the secret URL after reload, and the Studio keeps the one-time create URL only in component memory.

The Phase 3C acceptance gates verify the Cloudflare bindings, distinct limiter namespaces, admission ordering, no-expensive-side-effect rejection boundaries, token-hash persistence, 256-bit secret generation, non-secret owner list contract, public token route, owner/share Range parity, telemetry/billing isolation, one-time-link semantics, and compact responsive Studio sharing surface. This is repository source/configuration qualification only. Production deployment remains **manual-only**, no Phase 3C production deploy is performed by this qualification work, and production runtime remains **UNQUALIFIED** until the documented Container credential and real provider/media fixture gates pass.

## Phase 4A project-stable diarization qualification

Phase 4A source/CI qualification upgrades the bounded ASR media path to fixed 300-second chunks with 15-second overlap, giving a 285-second start-to-start step for interior chunks. The Worker requires explicit `overlapBeforeMs` and `overlapAfterMs` metadata from the FFmpeg Container and rejects malformed overlap manifests rather than silently inferring them.

Adjacent Deepgram chunks are normalized to project time, duplicate utterances in the shared overlap are persisted once, and strong duplicate evidence can join changed chunk-local speaker indexes into one project-stable speaker identity. Stitching is intentionally conservative: tied or ambiguous evidence does not merge speakers. Rerun reconciliation reuses an existing project speaker ID only when temporal coverage is uniquely strong enough; safe ID reuse preserves the existing display name, avatar metadata, and ElevenLabs voice mapping because speaker insertion remains conflict-ignore rather than an overwrite.

Phase 4A uses deterministic transcript/time evidence only and stores no biometric embedding, voiceprint, biometric template, or cross-project speaker identity. It adds no D1 schema migration and does not implement voice cloning. Workers AI fallback remains supported without diarization and keeps speaker IDs null.

Phase 3B usage accounting remains authoritative. ASR usage continues to record each actual provider-processed `chunk.durationMs / 1000`, including overlap audio that is intentionally sent to the ASR provider twice; there is no overlap discount, refund, pricing change, credit mutation, or new usage kind. Phase 3C telemetry and cancellation/failure semantics remain unchanged and payload-free.

The Phase 4A acceptance gates cover fixed overlap constants and strict media metadata, deterministic dedupe/stitch thresholds, fail-closed ambiguity, historical speaker reconciliation, speaker metadata preservation, no `0007` migration, no biometric identity subsystem, pipeline ordering, and unchanged provider usage units. This is repository source/CI qualification only. No Phase 4A production deploy is performed by this work, and production runtime remains **UNQUALIFIED** until the existing Cloudflare Container credential and real Deepgram/provider-media fixture gates pass.

## Studio reference qualification

Desktop reference qualification uses the supplied 1448×1086 YupVox workstation reference, while the responsive fidelity layer also remains active on common 1364px desktop screens. The production shell activates the isolated `reference-fidelity` presentation layer and keeps the approved three-column workstation geometry.

The exact-head CI screenshot is reviewed as a presentation qualification, not as a claim of literal pixel identity. The supplied reference contains a real wuxia video frame and uploaded-media metadata; an empty source-media state must remain truthful rather than fabricating footage or an uploaded file. This media-state difference does not qualify as a production runtime fixture.

Studio Pro V2 source acceptance covers the real media player, direct timeline manipulation and split behavior, revision-aware undo/redo, autosave conflict recovery, Workers AI / Google / Compare translation modes, the command palette and centralized keyboard commands, four inspector tabs, fail-closed visual lip-sync capability, and reduced-motion behavior. These are source/CI qualifications only; production runtime remains **UNQUALIFIED** until the documented Container credential and real-media fixture gates pass.

## Qualification status

A GREEN source CI and Wrangler dry-run qualify the repository source/configuration only. Production runtime PASS requires a real supported media fixture to traverse the deployed flow. For diarization qualification, the production fixture must be run with a valid `DEEPGRAM_API_KEY` and must return persisted speaker-linked segments with project-stable identity evidence across at least one overlapped chunk boundary. For final export qualification, a real ElevenLabs/FFmpeg run must write the final R2 artifact and make it retrievable through the export path; per-speaker voice routing is not production-qualified until that fixture verifies distinct configured voice IDs on real segments.

If those live fixtures have not been executed successfully, runtime status remains **UNQUALIFIED** rather than PASS. Cloudflare, Google, Deepgram, and ElevenLabs secret values are never committed to the repository.
