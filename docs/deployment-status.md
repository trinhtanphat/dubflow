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
-> FFmpeg Cloudflare Container probe + bounded 5-minute audio chunks
-> Deepgram Nova-3 diarized ASR when DEEPGRAM_API_KEY is configured
   OR Workers AI Whisper fallback when it is absent
-> deterministic/atomic D1 speaker + transcript persistence
-> Workers AI translation by default
-> project/job terminal state
-> Studio poll + transcript/timeline/speaker metadata hydration
-> server-backed transcript editing, speaker naming and per-speaker ElevenLabs voice assignment
-> ElevenLabs segment TTS using the assigned speaker voice when present
-> FFmpeg dubbed-audio timeline assembly/mux
-> final R2 export artifact
```

Deepgram speaker identities are currently **chunk-scoped**. A speaker index returned in one 5-minute request is not assumed to be the same person as the same index in another chunk. Cross-chunk identity stitching therefore remains unqualified and is not represented as implemented.

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

Five independent Cloudflare Rate Limiting bindings protect expensive operations with server-derived actor keys and one-minute windows: process `4/min`, export `4/min`, translation `30/min`, voice preview `30/min`, and upload `20/min`. A denial returns HTTP 429 with stable `RATE_LIMITED` semantics and `Retry-After: 60`. These counters are abuse/admission controls only: Phase 3C rate limiting and telemetry do not write `usage_events`, decrement `credit_balance`, establish pricing, or create a payment/quota system.

Final exported media can be shared through owner-managed, revocable links. Owners can create, list and revoke share records; plaintext bearer tokens are returned only in the create response, while D1 persists only a unique token hash plus a short non-secret hint. Share expiry is bounded from one hour to 30 days and the Studio defaults to seven days. Anonymous shared media requires both share ID and token, returns the same not-found shape for invalid/unknown/expired/revoked access, supports byte ranges, and sends `Referrer-Policy: no-referrer` so the bearer-token URL is not leaked through browser referrers. Owner listings never reconstruct or return the secret URL after reload.

The Phase 3C acceptance gates verify the Cloudflare bindings, distinct limiter namespaces, token-hash persistence, non-secret owner list contract, public token route, telemetry/billing isolation, and compact responsive Studio sharing surface. This is repository source/configuration qualification only. It does **not** qualify the deployed Container, real providers, or real-media runtime.

## Studio reference qualification

Desktop reference qualification uses the supplied 1448×1086 YupVox workstation reference, while the responsive fidelity layer also remains active on common 1364px desktop screens. The production shell activates the isolated `reference-fidelity` presentation layer and keeps the approved three-column workstation geometry.

The exact-head CI screenshot is reviewed as a presentation qualification, not as a claim of literal pixel identity. The supplied reference contains a real wuxia video frame and uploaded-media metadata; an empty source-media state must remain truthful rather than fabricating footage or an uploaded file. This media-state difference does not qualify as a production runtime fixture.

Studio Pro V2 source acceptance covers the real media player, direct timeline manipulation and split behavior, revision-aware undo/redo, autosave conflict recovery, Workers AI / Google / Compare translation modes, the command palette and centralized keyboard commands, four inspector tabs, fail-closed visual lip-sync capability, and reduced-motion behavior. These are source/CI qualifications only; production runtime remains **UNQUALIFIED** until the documented Container credential and real-media fixture gates pass.

## Qualification status

A GREEN source CI and Wrangler dry-run qualify the repository source/configuration only. Production runtime PASS requires a real supported media fixture to traverse the deployed flow. For diarization qualification, the production fixture must be run with a valid `DEEPGRAM_API_KEY` and must return persisted speaker-linked segments. For final export qualification, a real ElevenLabs/FFmpeg run must write the final R2 artifact and make it retrievable through the export path; per-speaker voice routing is not production-qualified until that fixture verifies distinct configured voice IDs on real segments.

If those live fixtures have not been executed successfully, runtime status remains **UNQUALIFIED** rather than PASS. Cloudflare, Google, Deepgram, and ElevenLabs secret values are never committed to the repository.
