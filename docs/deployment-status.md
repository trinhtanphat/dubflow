# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare account: `6c5207813df3d5b83b9508125e0e9e12`

Deployment is intentionally fail-closed. `npm run deploy` verifies source, runs a Wrangler dry run, deploys the Worker and Static Assets, applies D1 migrations by binding, and only reports success after `/api/ready` confirms the production schema exists.

The repository does not contain Cloudflare or Google API secrets and does not use GitHub Actions.
