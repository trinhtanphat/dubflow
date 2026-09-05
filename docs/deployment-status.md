# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`

Deployment is fail-closed. `npm run deploy` verifies source, runs a Wrangler dry run, deploys the Worker and Static Assets, applies D1 migrations by binding, and only reports success after `/api/ready` confirms the production schema exists.

GitHub Actions is enabled for this public repository. CI runs real dependency installation, tests, TypeScript/Vite build, and a Wrangler dry-run. Production deployment runs on pushes to `main` and can also be manually dispatched. It requires the `CLOUDFLARE_API_TOKEN` GitHub secret. The Cloudflare account ID is non-secret and pinned to the canonical account above.

## Reconciled live dubbing source path

The current reconciliation source implements:

```text
R2 multipart media upload
-> durable Cloudflare Workflow job
-> FFmpeg Cloudflare Container probe + bounded 5-minute audio chunks
-> Workers AI Whisper ASR
-> deterministic/atomic D1 transcript persistence
-> Workers AI translation by default
-> project/job terminal state
-> Studio Pro poll + transcript/timeline hydration
-> server-backed transcript editing and retranslation
```

Google Translation remains an optional configured provider. Compare mode does not persist a winner until the user explicitly applies it.

TTS preview, voice regeneration/cloning, visual lip-sync rendering, and final dubbed export remain capability-gated and are not represented as production-ready by this source integration.

## Qualification status

A GREEN source CI and Wrangler dry-run qualify the repository source/configuration only. Production runtime PASS requires a real supported media fixture to traverse the deployed flow and return persisted translated segments visible in Studio Pro. If that live fixture has not been executed successfully, runtime status remains **UNQUALIFIED** rather than PASS.

Cloudflare and Google API secret values are never committed to the repository.
