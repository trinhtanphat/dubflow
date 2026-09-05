# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`

Deployment is fail-closed. `npm run deploy` verifies source, runs a Wrangler dry run, deploys the Worker and Static Assets, applies D1 migrations by binding, and only reports success after `/api/ready` confirms the production schema exists.

GitHub Actions is enabled for this public repository. CI runs real dependency installation, tests, TypeScript/Vite build, a Wrangler dry-run, and captures a 1448×1086 headless Chromium screenshot from the exact tested SHA for Studio reference qualification. Production deployment is **manual-only** via `workflow_dispatch` while the Cloudflare Container credential is externally qualified. It requires the `CLOUDFLARE_API_TOKEN` GitHub secret. Because this deployment builds and pushes an FFmpeg Cloudflare Container, the token must include Cloudflare's **Containers Write** (or equivalent Containers Edit) permission in addition to the permissions needed for Workers and bound resources. The Cloudflare account ID is non-secret and pinned to the canonical account above.

The first live Container deploy attempt on the reconciled source proved the existing token can reach the Worker deployment path but returned `Unauthorized` when Wrangler moved into the Container image deployment. Until the token is replaced or updated with the required Container permission, do not treat production runtime as qualified and do not repeatedly auto-deploy `main`.

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

## Studio V2.2 reference qualification

Desktop reference qualification uses the supplied 1448×1086 YupVox workstation reference. The production shell activates the isolated `reference-fidelity` presentation layer and pins the approved desktop geometry contract: 76px topbar, 66px footer, 304px left/right rails, and a 16px player gutter that places the center media bounds at approximately x=320…1128.

The exact-head CI screenshot is reviewed as a presentation qualification, not as a claim of literal pixel identity. The supplied reference contains a real wuxia video frame and uploaded-media metadata; the default repository demo intentionally has no source media and therefore renders the truthful empty-player state instead of fabricating footage or an uploaded file. This media-state difference is expected and does not qualify as a production runtime fixture.

## Qualification status

A GREEN source CI and Wrangler dry-run qualify the repository source/configuration only. Production runtime PASS requires a real supported media fixture to traverse the deployed flow and return persisted translated segments visible in Studio Pro. If that live fixture has not been executed successfully, runtime status remains **UNQUALIFIED** rather than PASS.

Cloudflare and Google API secret values are never committed to the repository.