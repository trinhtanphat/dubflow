# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare account: `6c5207813df3d5b83b9508125e0e9e12`

Deployment is intentionally fail-closed. `npm run deploy` verifies source, runs a Wrangler dry run, deploys the Worker and Static Assets, applies D1 migrations by binding, and only reports success after `/api/ready` confirms the production schema exists.

GitHub Actions is enabled for this public repository. CI runs real dependency installation, tests, TypeScript/Vite build, and a Wrangler dry-run. Production deployment runs only from `main` or manual dispatch and requires the `CLOUDFLARE_API_TOKEN` GitHub secret. The Cloudflare account ID is non-secret and pinned to the canonical account above.

Cloudflare and Google API secret values are never committed to the repository.
