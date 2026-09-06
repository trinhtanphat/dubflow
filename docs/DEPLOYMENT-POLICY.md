# Deployment policy

## Single production deployment lane

`main` is the only production source of truth.

The required flow is:

1. Change code in Git.
2. Commit and push the change.
3. Merge the change into `main`.
4. Cloudflare Workers Builds detects the new `main` commit.
5. Cloudflare Workers Builds automatically builds the repository.
6. Cloudflare Workers Builds automatically deploys production from that same `main` commit.

Cloudflare Workers Builds is the only production deployment lane for this repository.

The canonical public deployment belongs to Cloudflare account `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`. That account owns the `yupvox.qs3d.site` custom-domain binding and the persisted production D1/R2 state. A second account must not be treated as production merely because it has a Worker named `dubflow` or a successful build.

## GitHub Actions responsibility

GitHub Actions is CI only. It may install dependencies, run tests, run the production build, perform `wrangler deploy --dry-run`, and capture test artifacts/screenshots.

GitHub Actions must not deploy production. Do not add a production `wrangler deploy`, remote D1 migration, `wrangler secret put`, Cloudflare production API call, or a second production deployment workflow to GitHub Actions.

`.github/workflows/deploy-cloudflare.yml` must not exist. Do not recreate it as a workaround for a Cloudflare build/deploy failure.

## Cloudflare responsibility

The Cloudflare project in the canonical production account must watch the GitHub repository's `main` branch. A new commit on `main` is the deployment trigger. Cloudflare owns the build/deploy environment and executes the configured production build/deploy commands.

If a Cloudflare build or deploy fails, fix the relevant source/configuration in this repository, commit it, and merge it to `main`; let Cloudflare retry through its normal `main`-change build flow. Do not introduce a parallel GitHub deploy path.

The repository-owned Workers Builds deploy command is `node scripts/cloudflare-workers-build-deploy.mjs`. The normal build phase remains remote-mutation free; the deployment phase owns the Worker upload, remote D1 migration application, and exact readiness qualification.

## Workers Builds API token for Containers

This project declares an FFmpeg Cloudflare Container, so the **API token selected by Cloudflare Workers Builds** must be authorized for any Container operation performed by the configured production deploy path. This is the token configured in the Cloudflare dashboard under the Worker at **Settings > Builds**; it is not a GitHub Actions secret and it must not be committed to this repository.

When Container publication is enabled in the production deploy path, the Workers Builds token must include the normal Worker/resource permissions needed by this project and **Containers Edit** for production account `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`.

A characteristic permission failure is:

1. Worker/assets upload succeeds.
2. The FFmpeg Docker image builds successfully.
3. Wrangler then ends with `Unauthorized` while publishing or applying the Container.

When that sequence occurs, treat it as a Workers Builds token/Cloudflare authorization problem. Update or replace the **Workers Builds API token in Settings > Builds** with one that includes **Containers Edit**, then let the normal `main` build deploy again. Do not add a GitHub production deploy workflow as a workaround.

The repository cannot grant Cloudflare account permissions to its own build token. Secret token values must never be stored in Git, tests, documentation, or CI configuration.

## Repository guard

CI contains regression tests that fail if a GitHub production deployment workflow is reintroduced, if CI starts performing a non-dry-run Wrangler deploy, if the checked-in production account drifts away from the account that owns the public custom domain and persisted project data, or if a stale HTTP 200 readiness payload lacks the exact current schema revision.

This policy is intentional and should be treated as a repository-level requirement.
