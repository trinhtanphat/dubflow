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
-> FFmpeg Cloudflare Container probe + bounded 300-second ASR windows with 15-second overlap
-> Deepgram Nova-3 diarized ASR when DEEPGRAM_API_KEY is configured
   OR Workers AI Whisper fallback when it is absent
-> conservative overlap duplicate suppression + evidence-based cross-chunk speaker stitching
-> deterministic project-stable speaker reconciliation against existing project history
-> deterministic/atomic D1 speaker + transcript persistence
-> context-aware Workers AI translation when project glossary/style is active
   OR raw Workers AI translation by default when project context is inactive
-> project/job terminal state
-> Studio poll + transcript/timeline/speaker metadata hydration
-> server-backed transcript editing, speaker naming and per-speaker ElevenLabs voice assignment
-> ElevenLabs segment TTS using the assigned speaker voice when present
-> FFmpeg dubbed-audio timeline assembly/mux
-> final R2 export artifact
```

Phase 4A replaces the earlier chunk-only/short-overlap source behavior with **conservative project-stable cross-chunk stitching**. Adjacent ASR windows overlap by fifteen seconds and the normal next-window step is 285 seconds. Duplicate utterances are candidates only when normalized non-empty text agrees, global start/end timing agrees within 1,500 ms, and the utterances actually overlap in time. A cross-chunk speaker union is accepted only when duplicate evidence contributes at least 750 ms of matched duration and the best local-speaker mapping is unique in both directions. Matching numeric speaker indexes, names, text alone without timing evidence, or other guesses are not sufficient. Ambiguous or missing evidence remains split into deterministic identities. Workers AI Whisper can use the same overlap duplicate suppression but never receives an invented speaker identity.

After all ASR work for the run finishes, the workflow loads existing project speaker-linked segment coverage before destructive replacement. A fresh stitched speaker may reuse one historical `speakerId` only when its temporal overlap with that historical speaker is uniquely best and reaches at least 2,000 ms. Ties or insufficient overlap keep the fresh deterministic ID. Reusing the existing ID preserves the existing D1 speaker record, including user-edited display name, avatar metadata, provider metadata, and per-speaker ElevenLabs voice assignment; the workflow does not create biometric embeddings, voiceprints, or a new speaker-identity store.

Per-speaker voice assignment is persisted on the existing D1 `speakers` records. Changing a speaker voice invalidates that speaker's previously generated dubbed segment audio plus any published project export before the next render; renaming a speaker does not discard valid audio. Missing per-speaker voice IDs continue to use the configured ElevenLabs default voice rather than fabricating an assignment.

Google Translation remains an optional configured provider. Compare mode does not persist a winner until the user explicitly applies it. Deepgram is also optional: without `DEEPGRAM_API_KEY`, the source falls back to Workers AI Whisper and `/api/ready` reports speaker diarization as unavailable while the base service can remain ready.

The deploy workflow supports optional `GOOGLE_CLOUD_TRANSLATE_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_DEFAULT_VOICE_ID` GitHub secrets and syncs configured values into Worker secrets without committing them.

Source support for final dubbed export now exists through the ElevenLabs + FFmpeg export workflow, including source-level per-speaker voice routing. Managed explicit-consent ElevenLabs Instant Voice Clone enrollment is source-supported by Phase 4B but remains production-unqualified. Visual lip-sync rendering remains capability-gated and unqualified.

## Phase 3B usage qualification

Phase 3B source/CI qualification adds a durable, idempotent internal usage ledger for ASR, translation, generated TTS audio, and final render. Canonical persisted/API units are seconds for ASR/TTS/render and Unicode source characters for translation. Usage operation identity includes durable job retry generation and provider, and `(operation_key, phase)` prevents automatic Workflow replay from duplicating the same logical started/completed event.

Authorized summaries are exposed through `GET /api/usage` and `GET /api/projects/:id/usage`. Project usage remains ownership-scoped and cross-user/missing project access is hidden behind a 404. The dashboard shows informational account usage and provider breakdown while keeping usage loading/errors isolated from project/job loading.

`users.credit_balance` remains informational/read-only, and Phase 3B does not decrement, reserve, price, enforce, or sell credits. `cost_basis` remains zero. There is no payment UI, upgrade CTA, quota enforcement, provider price table, rate-limit policy, observability policy, or public sharing control in this phase.

For Phase 4A overlapping ASR windows, Phase 3B remains the accounting source of truth and meters the **actual duration of every WAV sent to the ASR provider**, including the 15-second overlap processed by adjacent windows. Stitching or deduplication does not rewrite those usage events.

A GREEN Phase 3B acceptance gate qualifies repository source behavior only. It does **not** change the production-runtime status below: the Cloudflare Container credential and real provider/media fixture gates must still pass before runtime can be called qualified.

## Phase 3C observability, rate-limit, and sharing qualification

Phase 3C source/CI qualification adds Cloudflare-native operational telemetry and admission controls without turning them into billing or quota accounting. `ANALYTICS` is bound to the `dubflow_events` Analytics Engine dataset, invocation logs are enabled, query strings are redacted, and Worker traces use a 5% head-sampling rate. Telemetry remains bounded to opaque identifiers, operation/provider/status metadata, HTTP status and latency; transcript/media payloads, provider secrets, bearer tokens and raw URLs are outside the telemetry schema.

Five independent Cloudflare Rate Limiting bindings protect expensive operations with server-derived actor keys and one-minute windows: `RATE_LIMIT_PROCESS` is `4/min`, `RATE_LIMIT_EXPORT` is `4/min`, `RATE_LIMIT_TRANSLATE` is `30/min`, `RATE_LIMIT_VOICE` is `30/min`, and `RATE_LIMIT_UPLOAD` is `20/min`. Authorization/ownership and relevant input validation happen before the limiter is consumed; a denial returns HTTP 429 with stable `RATE_LIMITED` semantics and `Retry-After: 60` before jobs, Workflows, providers, multipart creation, usage writes, or project-state mutation. These counters are abuse/admission controls only: Phase 3C rate limiting and telemetry do not write `usage_events`, decrement `credit_balance`, establish pricing, or create a payment/quota system.

Final exported media can be shared through owner-managed, revocable links. Owners can create, list and revoke share records; plaintext bearer tokens are returned only in the create response, while D1 persists only a unique SHA-256 token hash plus a short non-secret hint. Share secrets are generated from 32 cryptographically random bytes. Share expiry is bounded from one hour to 30 days and the Studio defaults to seven days. Anonymous shared media requires both share ID and token; invalid, unknown, expired, revoked, and wrong-token access all converge on `404 SHARE_NOT_FOUND`. Owner and shared downloads use the same byte-range streaming path for 200/206/416 semantics, and public share responses send `Referrer-Policy: no-referrer` so the bearer-token URL is not leaked through browser referrers. Owner listings never reconstruct or return the secret URL after reload, and the Studio keeps the one-time create URL only in component memory.

The Phase 3C acceptance gates verify the Cloudflare bindings, distinct limiter namespaces, admission ordering, no-expensive-side-effect rejection boundaries, token-hash persistence, 256-bit secret generation, non-secret owner list contract, public token route, owner/share Range parity, telemetry/billing isolation, one-time-link semantics, and compact responsive Studio sharing surface. This is repository source/configuration qualification only. Production deployment remains **manual-only**, no Phase 3C production deploy is performed by this qualification work, and production runtime remains **UNQUALIFIED** until the documented Container credential and real provider/media fixture gates pass.

## Phase 4A translation context qualification

Phase 4A is **source-qualified only** for project-scoped translation style presets and glossary entries. The source/CI contract covers revision-safe D1 persistence, ownership-scoped settings and glossary APIs, one immutable translation-context snapshot per logical operation, contextual Workers AI routing, persisted segment context revision, Studio glossary/style controls, and unchanged Phase 3B `translation_character` accounting.

Raw Workers AI and Google Basic Translation remain context-incompatible paths and do not silently consume active project context. Contextual translation fails closed rather than silently falling back to a raw provider, and changing project translation settings does not automatically retranslate existing segments.

The contextual model runtime is not proven by source CI. Phase 4A does not change the existing production blocker: the Cloudflare Container credential still requires the missing Container permission, and no separate live contextual-model/media fixture qualification has been recorded. Production runtime status remains **UNQUALIFIED**.

## Phase 4A project-stable diarization qualification

Phase 4A source/CI qualification adds fixed overlapping ASR analysis windows, a pure conservative stitching layer, and safe rerun reconciliation against existing speaker history. The FFmpeg Container requests at most 300 seconds per ASR window with a 15-second overlap; the next normal window starts 285 seconds after the previous one. Returned offsets and overlap metadata are explicit Worker inputs rather than being re-derived in the workflow.

The stitching layer normalizes overlap text with Unicode NFKC, whitespace collapse, case normalization and punctuation/symbol removal. Duplicate candidates require the same non-empty normalized text, positive temporal intersection, and start/end agreement within 1,500 ms. The later observation of a confidently matched duplicate is removed. Cross-window diarized speaker evidence is merged only when the matched duplicate evidence contributes at least 750 ms and the best local-speaker mapping is mutual and unambiguous; tied mappings remain split. Accepted local identities receive deterministic fresh project speaker IDs, while undiarized observations retain `speakerId = null`.

For reruns, all new ASR work completes before the workflow reads prior persisted speaker coverage. A fresh stitched speaker reuses an existing project `speakerId` only when temporal overlap with that historical speaker is uniquely best and at least 2,000 ms; ties or insufficient evidence fail closed to the fresh ID. Existing speaker rows are preserved on conflict, so a reused speaker ID keeps user-edited names, avatar/provider metadata, and voice assignment instead of overwriting those fields. No diarization-specific schema migration, biometric embedding, voiceprint, or voice-cloning identity mechanism is introduced.

Phase 3B usage semantics are unchanged: ASR usage records the actual `chunk.durationMs / 1000` for every provider call, so overlap seconds remain counted even when transcript duplicates are removed before persistence.

These Phase 4A contracts are **source/CI qualification only**. They do not prove that production Deepgram diarization produces correct real-world project-stable identities. Production deployment remains **manual-only** and is not performed by Phase 4A. Production runtime remains **UNQUALIFIED** until the Cloudflare Container credential and real provider/media fixtures pass, including a valid `DEEPGRAM_API_KEY` fixture that demonstrates persisted speaker-linked segments across a real 15-second chunk boundary and a rerun that safely reuses an existing speaker identity.

## Phase 4B safe voice clone enrollment qualification

Phase 4B source/CI qualification adds managed ElevenLabs Instant Voice Clone (IVC) enrollment behind an explicit rights/consent gate. The user must intentionally provide a bounded audio sample; YupVox does not infer consent from project ownership, diarization, speaker names, or presence in uploaded source video, and it does not auto-extract source-video speech into the clone workflow.

Managed clone state is owner/project scoped in D1 with `creating`, `verification_required`, `ready`, `failed`, `deleting`, and `deleted` lifecycle states. Temporary sample objects are stored under server-generated R2 keys only until the provider attempt finishes. Cleanup runs after both provider success and provider failure, and a cleanup failure is surfaced as `VOICE_CLONE_SAMPLE_CLEANUP_FAILED` instead of reporting a successful enrollment while retaining the sample.

A dedicated `RATE_LIMIT_VOICE_CLONE` Cloudflare rate-limit lane protects provider enrollment independently from ordinary voice preview/TTS. Authorization, ownership, consent, lifecycle and sample validation occur before that limiter is consumed. The lane is an abuse/admission control only and does not create Phase 3B usage events, decrement credits or establish pricing.

ElevenLabs `requires_verification=true` maps to `verification_required`; that clone is persisted for lifecycle/deletion purposes but is not assignable. Only `ready` managed clones may be assigned to speakers, and assignment reuses the existing speaker voice update/invalidation path so previously generated dubbed audio and stale project exports are invalidated before a re-render. Provider deletion is fail-closed and is never reported as deleted when the provider operation fails.

The capability API distinguishes normal TTS preview from managed clone enrollment through `cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available }`. Studio surfaces consent, sample selection, creating, verification-required, ready, failed and deleting states truthfully; assignment remains an explicit user action and is never automatic after enrollment.

Professional Voice Clone creation/training/verification orchestration is outside Phase 4B scope. Phase 4B is **source/CI qualification only** and does not prove a production voice-cloning fixture. Production deployment remains **manual-only**, no Phase 4B production deploy is performed by this qualification work, and production runtime remains **UNQUALIFIED** until the existing Cloudflare Container credential and a real authorized ElevenLabs/media fixture pass.

## Studio reference qualification

Desktop reference qualification uses the supplied 1448×1086 YupVox workstation reference, while the responsive fidelity layer also remains active on common 1364px desktop screens. The production shell activates the isolated `reference-fidelity` presentation layer and keeps the approved three-column workstation geometry.

The exact-head CI screenshot is reviewed as a presentation qualification, not as a claim of literal pixel identity. The supplied reference contains a real wuxia video frame and uploaded-media metadata; an empty source-media state must remain truthful rather than fabricating footage or an uploaded file. This media-state difference does not qualify as a production runtime fixture.

Studio Pro V2 source acceptance covers the real media player, direct timeline manipulation and split behavior, revision-aware undo/redo, autosave conflict recovery, Workers AI / Google / Compare translation modes, the command palette and centralized keyboard commands, four inspector tabs, fail-closed visual lip-sync capability, and reduced-motion behavior. These are source/CI qualifications only; production runtime remains **UNQUALIFIED** until the documented Container credential and real-media fixture gates pass.

## Qualification status

A GREEN source CI and Wrangler dry-run qualify the repository source/configuration only. Production runtime PASS requires a real supported media fixture to traverse the deployed flow. For diarization qualification, the production fixture must be run with a valid `DEEPGRAM_API_KEY` and must return persisted speaker-linked segments across a real 15-second cross-window boundary; a rerun must also demonstrate safe historical speaker-ID reuse without overwriting user metadata. For contextual translation qualification, a configured `CONTEXT_TRANSLATION_MODEL` must successfully process a real project glossary/style fixture without silent raw-provider fallback. For final export qualification, a real ElevenLabs/FFmpeg run must write the final R2 artifact and make it retrievable through the export path; per-speaker voice routing is not production-qualified until that fixture verifies distinct configured voice IDs on real segments. Managed IVC likewise remains production-unqualified until an authorized real provider fixture creates a clone, satisfies any provider verification requirement, assigns only a `ready` clone, and proves provider/sample cleanup boundaries.

If those live fixtures have not been executed successfully, runtime status remains **UNQUALIFIED** rather than PASS. Cloudflare, Google, Deepgram, ElevenLabs, and contextual-model secret values are never committed to the repository.
