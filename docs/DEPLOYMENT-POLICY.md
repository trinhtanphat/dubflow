# Deployment policy

## Canonical source of truth

`main` is the only production source of truth for DubFlow backend and public gateway configuration.

Production is split across two Cloudflare accounts:

- `trinhtanphat6666` (`6c5207813df3d5b83b9508125e0e9e12`) owns the **DubFlow backend** Worker and its D1/R2/Workers AI/Analytics/Workflow/rate-limit resources.
- `trinhtanphat2403` (`50afb4fd3c4c7a1f3e1bdb7f22d4af7f`) owns the `qs3d.site` zone and the thin **gateway** Worker for `yupvox.qs3d.site`.

Administrative access across both accounts does not merge account-scoped Worker resources with zone ownership. The detailed topology and runbook are in `docs/CLOUDFLARE-CROSS-ACCOUNT-WORKERS-ONLY.md`.

## Backend production lane

Cloudflare Workers Builds remains the backend production deployment lane for `dubflow` in `trinhtanphat6666`.

The required backend flow is:

1. Change code in Git.
2. Commit and push the change.
3. Merge the fully qualified change into `main`.
4. Cloudflare Workers Builds detects the new `main` commit for the account-6666 `dubflow` project.
5. Cloudflare Workers Builds builds the repository.
6. Cloudflare deploys the backend using `wrangler.jsonc`.

`wrangler.jsonc` must target account `6c5207813df3d5b83b9508125e0e9e12`, keep `workers_dev = true`, and must not contain the `yupvox.qs3d.site` custom-domain route. The backend account does not own the `qs3d.site` zone.

The Cloudflare build command may remain `npm run build`. A direct deploy command `npx wrangler deploy` is valid for the account-6666 backend because the checked-in backend config no longer claims the account-2403 custom domain and no longer declares paid Containers.

## Public gateway

`wrangler.gateway.jsonc` is the only checked-in Wrangler config that may attach `yupvox.qs3d.site`.

It targets `trinhtanphat2403` and deploys `dubflow-gateway`, which owns no DubFlow D1/R2/Workflow state. The gateway forwards requests to the exact account-6666 `workers.dev` origin supplied through `BACKEND_ORIGIN`.

Do not guess or commit an account subdomain. Resolve the exact backend `workers.dev` URL from a successful backend deployment, verify it, and then configure `BACKEND_ORIGIN` for the gateway. If the variable is absent or invalid, the gateway must fail closed rather than loop or proxy to an unknown origin.

## GitHub Actions responsibility

GitHub Actions is CI only. It may install dependencies, run tests, run the production build, perform Wrangler dry-runs, typecheck the gateway, and capture test artifacts/screenshots.

GitHub Actions **must not deploy production**. Production deployment stays in Cloudflare; do not add a GitHub production deployment workflow as a workaround for Cloudflare configuration failures.

`.github/workflows/deploy-cloudflare.yml` must not exist.

## Containers disabled

Cloudflare **Containers are disabled in production** for this topology because the production deployment intentionally avoids the paid Containers runtime.

Production `wrangler.jsonc` must not declare `containers`, container-backed `durable_objects`, Container `exports`, `FFMPEG_CONTAINER`, or `SEPARATOR_CONTAINER` bindings.

The FFmpeg/Demucs source adapters and Docker/test fixtures may remain in the repository as source-only implementation material. They are not production bindings and must not be described as a live Container runtime.

**Containers Edit is not required** while Containers remain disabled.

Without the container bindings, media paths that require FFmpeg/Demucs remain fail-closed and production runtime qualification for those capabilities stays **UNQUALIFIED**. Do not silently restore a paid runtime just to turn those capabilities green.

## Failure handling

If the account-6666 backend build/deploy fails, fix the backend source/configuration in this repository and merge the qualified fix to `main`; do not move D1/R2 state into the zone account as a shortcut.

If the account-2403 gateway is wrong, roll back or update only the gateway and its `BACKEND_ORIGIN`; do not move the `qs3d.site` zone or duplicate production data.

The public hostname and backend state are separate responsibilities:

- public hostname / TLS / custom domain: account 2403;
- application runtime and persisted D1/R2 state: account 6666.

## Repository guard

CI must reject the following regressions:

- backend account drift away from `trinhtanphat6666`;
- a custom-domain route reappearing in backend `wrangler.jsonc`;
- the gateway account drifting away from `trinhtanphat2403`;
- the public hostname moving out of `wrangler.gateway.jsonc`;
- paid Container bindings reappearing in production config;
- GitHub Actions becoming a production deployment lane;
- a stale readiness payload being treated as qualified production evidence.

This policy is intentional and should be treated as a repository-level requirement.
