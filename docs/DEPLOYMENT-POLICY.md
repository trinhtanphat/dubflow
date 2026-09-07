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

The canonical public deployment belongs only to Cloudflare account `50afb4fd3c4c7a1f3e1bdb7f22d4af7f` (`trinhtanphat2403`). That account owns the `yupvox.qs3d.site` production lane and persisted production resources. No other Cloudflare account may be substituted merely because it has a Worker named `dubflow` or a successful build.

## GitHub Actions responsibility

GitHub Actions is CI only. It may install dependencies, run tests, run the production build, perform `wrangler deploy --dry-run`, and capture test artifacts/screenshots.

GitHub Actions must not deploy production. Do not add a production `wrangler deploy`, remote D1 migration, `wrangler secret put`, Cloudflare production API call, or a second production deployment workflow to GitHub Actions.

`.github/workflows/deploy-cloudflare.yml` must not exist. Do not recreate it as a workaround for a Cloudflare build/deploy failure.

## Cloudflare responsibility

The Cloudflare project in the canonical production account must watch the GitHub repository's `main` branch. A new commit on `main` is the deployment trigger. Cloudflare owns the build/deploy environment and executes the configured production build/deploy commands.

If a Cloudflare build or deploy fails, fix the relevant source/configuration in this repository, commit it, and merge it to `main`; let Cloudflare retry through its normal `main`-change build flow. Do not introduce a parallel GitHub deploy path.

The repository-owned Workers Builds deploy command is `node scripts/cloudflare-workers-build-deploy.mjs`. The normal build phase remains remote-mutation free; the deployment phase owns the Worker upload, remote D1 migration application, and exact readiness qualification.

## Container-free production lane

Cloudflare Workers Builds production is intentionally **container-free**. `scripts/cloudflare-workers-build-deploy.mjs` generates `.wrangler-production.json` and removes `containers` plus their `durable_objects` bindings before Wrangler deploys production. This keeps the live deployment on Workers/Cloudflare-native resources without enabling paid Cloudflare Containers.

The checked-in `wrangler.jsonc` may retain optional container capability declarations for development, compatibility, or future qualification, but those declarations are not part of the Workers Builds production configuration. Do not change the production deploy script to publish Containers unless that production policy is explicitly changed later.

The production deploy script also hard-pins account `50afb4fd3c4c7a1f3e1bdb7f22d4af7f` when generating `.wrangler-production.json`. This is a defense-in-depth guard against accidental account drift in the checked-in source config.

## Repository guard

CI contains regression tests that fail if a GitHub production deployment workflow is reintroduced, if CI starts performing a non-dry-run Wrangler deploy, if the checked-in production account drifts away from account `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`, if Workers Builds stops hard-pinning that account, if the production config stops stripping paid Container bindings, or if a stale HTTP 200 readiness payload lacks the exact current schema revision.

This policy is intentional and should be treated as a repository-level requirement.
