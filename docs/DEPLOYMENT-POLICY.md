# Deployment policy

## Canonical source of truth

`main` is the only production source of truth for DubFlow backend and public gateway configuration.

Production is intentionally split across two Cloudflare accounts:

- `trinhtanphat6666` (`6c5207813df3d5b83b9508125e0e9e12`) owns the **DubFlow backend** Worker and its D1/R2/Workers AI/Analytics/Workflow/rate-limit/Stream resources.
- `trinhtanphat2403` (`50afb4fd3c4c7a1f3e1bdb7f22d4af7f`) owns the `qs3d.site` zone and the thin **gateway** Worker for `yupvox.qs3d.site`.

Administrative access across both accounts does not merge account-scoped Worker resources with zone ownership.

## Backend production lane

Cloudflare Workers Builds is the only production deployment lane for the DubFlow backend. It watches `main` in account `trinhtanphat6666`, automatically builds the repository, and automatically deploys the backend from that same admitted `main` commit.

The backend `wrangler.jsonc` must target account `6c5207813df3d5b83b9508125e0e9e12`, keep `workers_dev = true`, and must not claim `yupvox.qs3d.site`. Backend D1/R2/Workers AI/Analytics/Workflows/rate limits and Cloudflare Stream stay with that backend account.

The repository-owned Workers Builds deploy command is `node scripts/cloudflare-workers-build-deploy.mjs`. The deployment phase owns Worker upload, remote D1 migration application, and readiness verification.

That deploy runner delegates temporary production-config generation to the pure `scripts/cloudflare-workers-build-config.mjs` module. The generator writes `.wrangler-production.json` from `wrangler.jsonc` while defensively removing `containers`, `durable_objects`, top-level `exports`, and `routes`. It never changes the backend account or removes the zero-container Stream binding.

## Public gateway

`wrangler.gateway.jsonc` is the only checked-in Wrangler config allowed to attach `yupvox.qs3d.site`.

It targets account `trinhtanphat2403` and deploys `dubflow-gateway`, which owns no DubFlow D1/R2/Workflow state. It proxies to the exact verified account-6666 `workers.dev` origin supplied through `BACKEND_ORIGIN`. The gateway must fail closed when that origin is absent, invalid, or points back to the public hostname.

## GitHub Actions responsibility

GitHub Actions is CI only. It may install dependencies, run tests, run the production build, perform Wrangler dry-runs, typecheck the gateway, and capture test artifacts/screenshots.

CI must dry-run both the checked-in backend `wrangler.jsonc` and the exact generated `.wrangler-production.json`. CI may invoke only the pure config generator to create that temporary file; it must not invoke the Workers Builds deployment runner, remote migrations, readiness mutation, or any non-dry-run production deployment. The generated file is removed after qualification.

GitHub Actions **must not deploy production**. Do not add a production `wrangler deploy`, remote D1 migration, secret mutation, Cloudflare production API call, or alternate production deployment workflow to GitHub Actions.

`.github/workflows/deploy-cloudflare.yml` must not exist.

## Zero-container Stream media runtime

Cloudflare **Containers are disabled in production**. Production config must not declare `containers`, Container-backed `durable_objects`, Container exports, `FFMPEG_CONTAINER`, or `SEPARATOR_CONTAINER`.

The active media path is zero-container: private R2 source -> Cloudflare Stream source preparation -> remote ASR -> translation/TTS -> Worker-native PCM/WAV soundtrack assembly -> Cloudflare Stream dubbed MP4 publishing. There is no hidden FFmpeg Container fallback.

The backend Worker requires its normal account-6666 Cloudflare Stream binding plus runtime secrets `CLOUDFLARE_STREAM_API_TOKEN` and `STREAM_SOURCE_SIGNING_SECRET`. Secret values are managed in Cloudflare and must never be committed to Git, tests, screenshots, logs, or documentation.

Cloudflare Workers Builds uses its configured deployment credential under **Settings > Builds**. No `Containers Edit` permission is required for this production path. If deployment authorization fails, fix the Cloudflare build credential and let the normal `main` build deploy again; do not add a GitHub deployment workaround.

## Repository guards

CI must fail if any of these regressions return:

- backend `wrangler.jsonc` claims `yupvox.qs3d.site` or targets the gateway account;
- `wrangler.gateway.jsonc` stops targeting account 2403 or stops owning the public custom domain;
- paid Container runtime bindings, dormant Durable Object lifecycle exports, or custom-domain routes survive into the generated backend production config;
- the zero-container Stream binding disappears from the backend;
- CI stops validating the exact generated `.wrangler-production.json`;
- GitHub Actions invokes the production deployment runner or gains any production deployment path;
- readiness accepts a stale schema revision.

This policy is intentional and should be treated as a repository-level requirement.
