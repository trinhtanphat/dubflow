# Deployment policy

## Canonical source of truth

`main` is the only production source of truth for DubFlow backend and public gateway configuration.

Production is intentionally split across two Cloudflare accounts:

- `trinhtanphat6666` (`6c5207813df3d5b83b9508125e0e9e12`) owns the **DubFlow backend** Worker and its D1/R2/Workers AI/Analytics/Workflow/rate-limit resources.
- `trinhtanphat2403` (`50afb4fd3c4c7a1f3e1bdb7f22d4af7f`) owns the `qs3d.site` zone and the thin **gateway** Worker for `yupvox.qs3d.site`.

Administrative access across both accounts does not merge account-scoped Worker resources with zone ownership.

## Backend production lane

Cloudflare Workers Builds is the only production deployment lane for the DubFlow backend. It watches `main` in account `trinhtanphat6666`, automatically builds the repository, and automatically deploys the backend from that same admitted `main` commit.

The backend `wrangler.jsonc` must target account `6c5207813df3d5b83b9508125e0e9e12`, keep `workers_dev = true`, and must not claim `yupvox.qs3d.site`. Backend D1/R2/Workers AI/Analytics/Workflows/rate limits stay with that backend account.

The repository-owned Workers Builds deploy command is `node scripts/cloudflare-workers-build-deploy.mjs`. The deployment phase owns Worker upload, remote D1 migration application, and readiness verification.

That deploy runner delegates temporary production-config generation to the pure `scripts/cloudflare-workers-build-config.mjs` module. The generator writes `.wrangler-production.json` from `wrangler.jsonc` while defensively removing `containers`, `durable_objects`, top-level `exports`, `stream`, and `routes`. It never changes the backend account.

## Public gateway

`wrangler.gateway.jsonc` is the only checked-in Wrangler config allowed to attach `yupvox.qs3d.site`.

It targets account `trinhtanphat2403` and deploys `dubflow-gateway`, which owns no DubFlow D1/R2/Workflow state. It proxies to the exact verified account-6666 `workers.dev` origin supplied through `BACKEND_ORIGIN`. The gateway must fail closed when that origin is absent, invalid, or points back to the public hostname.

`BACKEND_ORIGIN` is runtime configuration and must not be hard-coded into source. Because normal Wrangler/Workers Builds deployments can otherwise replace runtime variables that are not present in the checked-in config, `wrangler.gateway.jsonc` must keep `keep_vars = true` so an operator-configured `BACKEND_ORIGIN` survives automatic gateway deployments.

The gateway Workers Builds deploy command is `node scripts/cloudflare-gateway-workers-build-deploy.mjs`. That repository-owned runner deploys the checked-in `wrangler.gateway.jsonc` directly. The Cloudflare build trigger must not use inline JavaScript that deletes `routes`, changes `workers_dev`, or synthesizes a second gateway Wrangler config.

## GitHub Actions responsibility

GitHub Actions is CI only. It may install dependencies, run tests, run the production build, perform Wrangler dry-runs, typecheck the gateway, and capture test artifacts/screenshots.

CI must dry-run both the checked-in backend `wrangler.jsonc` and the exact generated `.wrangler-production.json`. CI may invoke only the pure config generator to create that temporary file; it must not invoke the Workers Builds deployment runner, remote migrations, readiness mutation, or any non-dry-run production deployment. The generated file is removed after qualification.

GitHub Actions **must not deploy production**. Do not add a production `wrangler deploy`, remote D1 migration, secret mutation, Cloudflare production API call, or alternate production deployment workflow to GitHub Actions.

`.github/workflows/deploy-cloudflare.yml` must not exist.

## R2-only media runtime

Cloudflare **Containers are disabled in production**. Production config must not declare `containers`, Container-backed `durable_objects`, Container exports, `FFMPEG_CONTAINER`, or `SEPARATOR_CONTAINER`.

Cloudflare Stream is also removed from the admitted production media runtime. Production config must not declare a Stream binding, and runtime readiness must not require `CLOUDFLARE_STREAM_API_TOKEN` or a Cloudflare account id for media operations.

The active path is **R2-only**: private R2 source -> short-lived signed R2 media URL -> remote ASR -> translation/TTS -> Worker-native PCM/WAV soundtrack -> H.264/AVC packet-copy plus AAC soundtrack MP4 remux -> private R2 final export. Unsupported video must fail with `VIDEO_TRANSCODE_REQUIRED`; it must not silently fall back to Stream or Containers.

The canonical runtime secret is `MEDIA_SOURCE_SIGNING_SECRET`. `STREAM_SOURCE_SIGNING_SECRET` is accepted only as a temporary migration alias while the live control-plane secret is moved to the canonical name. Secret values are managed in Cloudflare and must never be committed to Git, tests, screenshots, logs, or documentation.

Readiness revision 14 requires the `MEDIA` R2 binding, `PUBLIC_ORIGIN`, a media-source signing secret, and the bundled remux/AAC capability. The public readiness payload must report `media.r2 = "ready"` and `media.remux = "ready"`. Historical Stream-named D1 fields and the already-shipped `0012_stream_media.sql` migration remain intact solely for lineage/backward-readable state; new jobs do not depend on them.

Cloudflare Workers Builds uses its configured deployment credential under **Settings > Builds**. No `Containers Edit` permission is required. No Cloudflare Stream permission is required by the admitted R2-only runtime. If deployment authorization fails, fix the Cloudflare build credential and let the normal `main` build deploy again; do not add a GitHub deployment workaround.

## Repository guards

CI must fail if any of these regressions return:

- backend `wrangler.jsonc` claims `yupvox.qs3d.site` or targets the gateway account;
- `wrangler.gateway.jsonc` stops targeting account 2403 or stops owning the public custom domain;
- gateway runtime-variable preservation is disabled while `BACKEND_ORIGIN` remains operator-configured outside source;
- the gateway Workers Builds lane stops using the repository-owned runner or mutates away the checked-in custom-domain contract;
- paid Container runtime bindings, Stream bindings, dormant Durable Object lifecycle exports, or custom-domain routes survive into the generated backend production config;
- active Worker code imports `StreamMediaService`, `cloudflare/stream`, or requires `CLOUDFLARE_STREAM_API_TOKEN`;
- CI stops validating the exact generated `.wrangler-production.json`;
- GitHub Actions invokes the production deployment runner or gains any production deployment path;
- readiness accepts a stale schema revision or a payload without ready R2/remux capability;
- already-shipped D1 migration filenames are renamed or rewritten.

This policy is intentional and should be treated as a repository-level requirement.
