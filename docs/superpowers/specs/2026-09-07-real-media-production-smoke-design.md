# Real-Media Production Smoke Design

## Goal

Add a repeatable production qualification path that exercises the real public DubFlow stack end to end with a short MP4 containing spoken English, and proves that the production pipeline can reach `needs_review`, create a dubbed MP4 export, and serve that exported object back from production storage.

## Scope

The smoke must exercise the deployed public origin at `https://yupvox.qs3d.site` through the existing API only. It must not bypass D1, R2, Cloudflare Stream, Workflows, ASR, translation, voice generation, or export persistence.

The flow is:

1. Create an `en -> vi` project with an `e2e-smoke-` title.
2. Begin a multipart upload for a short MP4.
3. Upload the MP4 bytes as part 1 and complete the multipart upload.
4. Start dubbing with `POST /api/projects/:id/process`.
5. Poll the job and project until the dubbing job completes and the project status becomes `needs_review`.
6. Start a Vietnamese dubbed export using `audioMode=dubbed_only` and `visualMode=standard`.
7. Poll the export attempt until it is `completed`.
8. Assert the completed export record contains a non-empty `exportObjectKey`.
9. Fetch the exported media from `/api/projects/:id/exports/vi/media?output=dubbed` and prove it is an MP4-like non-empty response. Also issue a range request and require a partial response when supported.
10. Emit a JSON summary containing the project id, dubbing job id, export id, export job id, export object key, media byte count, content type, and final statuses.

## Safety and Cost Controls

The permanent workflow is manual-only through `workflow_dispatch` and requires an explicit confirmation input equal to `RUN_LIVE_MEDIA_SMOKE` before invoking paid or quota-consuming providers.

The qualification fixture is generated inside GitHub Actions with `espeak-ng` and `ffmpeg`; no media binary is committed to the repository.

The repository currently has no project deletion endpoint. This feature must not add a public deletion endpoint only for test cleanup. A successful qualification therefore leaves one small, clearly prefixed smoke project and its associated storage/provider artifacts for operator inspection.

## Testability

A source-contract test must fail until both the smoke runner and the workflow exist and contain the required production sequence, safety guard, timeout behavior, and artifact upload. The test is run locally in CI and does not make network calls.

The live production run is a separate qualification step. For initial branch qualification only, the workflow may temporarily include a branch-specific push trigger. That temporary trigger must be removed before merge so `main` retains manual-only execution.

## Failure Behavior

The runner must fail fast on unexpected HTTP responses and include response status/body context without printing secrets. Polling must have explicit bounded timeouts. Terminal job/export failures must surface their returned error fields in the thrown error.

The smoke must never convert a production failure into a skipped or successful result merely because a provider is unavailable.

## Non-Goals

- No automatic execution on every push to `main`.
- No dashboard-only Cloudflare verification.
- No new user authentication scheme.
- No new delete-project API.
- No lip-sync or dialogue-separation qualification in this smoke; the export uses the standard visual path and dubbed-only audio path to validate the core zero-container production media route.
