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

## GitHub Actions responsibility

GitHub Actions is CI only. It may install dependencies, run tests, run the production build, perform `wrangler deploy --dry-run`, and capture test artifacts/screenshots.

GitHub Actions must not deploy production. Do not add a production `wrangler deploy`, remote D1 migration, `wrangler secret put`, Cloudflare production API call, or a second production deployment workflow to GitHub Actions.

`.github/workflows/deploy-cloudflare.yml` must not exist. Do not recreate it as a workaround for a Cloudflare build/deploy failure.

## Cloudflare responsibility

The Cloudflare project must watch the GitHub repository's `main` branch. A new commit on `main` is the deployment trigger. Cloudflare owns the build/deploy environment and executes the configured production build/deploy commands.

If a Cloudflare build or deploy fails, fix the relevant source/configuration in this repository, commit it, and merge it to `main`; let Cloudflare retry through its normal `main`-change build flow. Do not introduce a parallel GitHub deploy path.

## Repository guard

CI contains regression tests that fail if a GitHub production deployment workflow is reintroduced or if CI starts performing a non-dry-run Wrangler deploy.

This policy is intentional and should be treated as a repository-level requirement.
