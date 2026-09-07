# Phase 4D explicit background preparation qualification

Phase 4D keeps the canonical dubbed-audio modes `dubbed_only`, `duck_original`, and `separated_background`. This document covers the explicit preparation contract for `separated_background` after reconciliation with the current `main` schema (`source_generation` + `project_audio_stems`).

## Source contract

Background separation is an explicit operation, not an export side effect:

1. `GET /api/projects/{projectId}/separation` reads durable state only. It never starts provider work.
2. Studio shows `Not prepared`, `Processing`, `Ready`, `Failed`, or `Stale`, plus `Unqualified` when runtime qualification is absent.
3. `POST /api/projects/{projectId}/separation` starts or explicitly retries the dedicated `SeparationWorkflow` only after ownership, source, duration, provider qualification, and `RATE_LIMIT_SEPARATION` admission checks pass.
4. The workflow uses the pinned source adapter `demucs-container-htdemucs-8726e21a` (`demucs==4.0.1`, model `htdemucs`, digest `sha256:8726e21a`) and persists canonical background/dialogue stems under `projects/{projectId}/stems/{sourceGeneration}/{provider}/...`.
5. `separated_background` export only reuses a completed current-generation background stem. Export never calls the separation provider and never silently falls back to `duck_original` or `dubbed_only`.

The source rate-limit lane is isolated as `RATE_LIMIT_SEPARATION` with a `2/min` admission budget. It is abuse/admission control, not pricing or billing state.

## Production boundary

`SEPARATION_RUNTIME_QUALIFIED` defaults to `false`. Cloudflare Workers Builds remains the only production deployment lane and its production config intentionally strips container and Durable Object deployment. GitHub Actions remains CI-only and must not deploy production.

Therefore source CI, a Wrangler dry-run, a successful merge, or an automatic Workers Builds deployment does **not** qualify separated-background runtime behavior. Production remains **UNQUALIFIED** until a provider-specific real-media qualification run proves all of the following on the canonical production account:

- authorized source media can be separated by the pinned provider/model identity;
- both durable stems are written under the exact current `sourceGeneration` and provider prefix;
- `GET .../separation` transitions truthfully through processing to ready;
- a `separated_background` export reuses the prepared background stem without launching separation again;
- source replacement makes prior-generation stems stale/unusable;
- cancellation, provider failure, workflow retry, rate limiting, and invalid artifact keys all fail closed;
- final rendered media is retrievable and audibly preserves the prepared background bed with dubbed voices.

Only after that evidence is captured may `SEPARATION_RUNTIME_QUALIFIED` be enabled for the qualified deployment. Until then the Studio must continue to show `Unqualified` and disable preparation/export admission for `separated_background`.
