# Cloudflare cross-account Workers-only production topology

Status: **canonical production architecture**

Last updated: 2026-09-07

## Goal

Keep the `qs3d.site` zone in the Cloudflare account that owns it while running the DubFlow backend in the separate account selected for Workers runtime. Paid Cloudflare Containers are intentionally disabled.

## Account ownership

| Role | Cloudflare account | Account ID | Owns |
| --- | --- | --- | --- |
| Public zone / gateway | `trinhtanphat2403` | `50afb4fd3c4c7a1f3e1bdb7f22d4af7f` | `qs3d.site`, `yupvox.qs3d.site`, thin gateway Worker |
| DubFlow backend | `trinhtanphat6666` | `6c5207813df3d5b83b9508125e0e9e12` | `dubflow` Worker, D1, R2, Analytics Engine, Workers AI, Workflows, rate limits, Cloudflare Stream |

The two Cloudflare accounts are administered by the same operator, but Cloudflare still treats account-scoped Worker resources and zone ownership separately. Therefore the backend Wrangler config must not try to attach `yupvox.qs3d.site` from account `trinhtanphat6666`.

## Request path

```text
Browser / API client
        |
        v
https://yupvox.qs3d.site
        |
        v
trinhtanphat2403
  dubflow-gateway
        |
        | HTTPS proxy
        v
BACKEND_ORIGIN
  dubflow.<account-subdomain>.workers.dev
        |
        v
trinhtanphat6666
  DubFlow Worker
   |- D1
   |- R2
   |- Workers AI
   |- Analytics Engine
   |- Workflows
   |- rate limits
   `- Cloudflare Stream
```

`wrangler.gateway.jsonc` is the only checked-in Wrangler config allowed to attach the public custom domain. `wrangler.jsonc` is the backend config and intentionally has no `routes`; it exposes the backend through `workers.dev` instead.

## Containers are disabled

Cloudflare Containers are **disabled in production** because this deployment intentionally avoids the paid Containers runtime.

The backend `wrangler.jsonc` must not contain:

- `containers`
- Container-backed `durable_objects`
- Container `exports`
- `FFMPEG_CONTAINER` or `SEPARATOR_CONTAINER` bindings

The generated Workers Builds production config is created by `scripts/cloudflare-workers-build-config.mjs`. As defense in depth it strips `containers`, `durable_objects`, top-level `exports`, and `routes` before deployment while preserving the backend account and zero-container Stream binding.

`Containers Edit` is **not required** for the production Workers Builds token while this topology remains in force.

### Active media runtime without Containers

The active dubbed-media path is zero-container:

```text
private R2 source
  -> signed project-scoped source access
  -> Cloudflare Stream source preparation
  -> remote ASR when supported
  -> translation / ElevenLabs PCM TTS
  -> Worker-native PCM/WAV soundtrack assembly
  -> Cloudflare Stream dubbed MP4 publishing
  -> canonical R2 export object
```

The production Worker has no hidden FFmpeg Container fallback. Standard `dubbed_only` exports use the Stream/PCM path. Legacy hybrid audio modes that still depend on dialogue separation remain fail-closed while no qualified non-Container separation runtime is configured.

Visual lip-sync remains an optional provider path layered after the canonical standard dubbed export. It is admitted only when the provider is configured and runtime-qualified; standard output remains durable even if optional visual processing fails.

Do not restore paid Container bindings merely to make a media feature appear available. Any future runtime that changes these boundaries must be explicitly implemented, qualified, and documented.

## Backend deployment: `trinhtanphat6666`

Canonical config: `wrangler.jsonc`

Required properties:

- `account_id = 6c5207813df3d5b83b9508125e0e9e12`
- `name = dubflow`
- `workers_dev = true`
- no custom-domain route
- no Container/Durable Object deployment
- D1/R2/AI/Analytics/Workflow/rate-limit/Stream bindings stay on this account

Cloudflare Workers Builds for `dubflow` watches `main`. The repository-owned production runner is `node scripts/cloudflare-workers-build-deploy.mjs`. It delegates config generation to `scripts/cloudflare-workers-build-config.mjs`, deploys `.wrangler-production.json`, applies remote D1 migrations, then verifies readiness.

GitHub Actions is CI only. It dry-runs both checked-in `wrangler.jsonc` and the exact generated `.wrangler-production.json`; it must not invoke the production deploy runner or perform a non-dry-run production deployment.

After the backend deploy succeeds, record the exact `workers.dev` origin printed by Wrangler, for example:

```text
https://dubflow.<account-subdomain>.workers.dev
```

Do not guess the account subdomain.

## Public gateway deployment: `trinhtanphat2403`

Canonical config: `wrangler.gateway.jsonc`

The gateway is intentionally thin. It owns no DubFlow D1/R2/Workflow state. It only proxies the public hostname to the backend origin and rewrites same-origin redirects back to `https://yupvox.qs3d.site`.

The gateway requires one runtime variable:

```text
BACKEND_ORIGIN=https://dubflow.<exact-6666-account-subdomain>.workers.dev
```

Set `BACKEND_ORIGIN` to the exact backend origin returned by the successful account-6666 deploy. It is an origin, not a path, and must use HTTPS.

Example deployment after resolving the exact origin:

```bash
npx wrangler deploy --config wrangler.gateway.jsonc --var BACKEND_ORIGIN:https://dubflow.<exact-6666-account-subdomain>.workers.dev
```

Equivalent configuration through the Cloudflare dashboard is acceptable. The source intentionally has no guessed default; if `BACKEND_ORIGIN` is missing or invalid, the gateway returns HTTP 503 with `BACKEND_ORIGIN_UNAVAILABLE` instead of looping or forwarding to an unknown target.

## Deployment order

1. Merge a fully green source commit to `main`.
2. Let Cloudflare Workers Builds generate and deploy `.wrangler-production.json` in `trinhtanphat6666`.
3. Apply the remote D1 migration chain and pass readiness verification.
4. Confirm Wrangler reports the backend `workers.dev` URL.
5. Verify the backend directly at `<BACKEND_ORIGIN>/api/ready`.
6. Deploy/update `dubflow-gateway` in `trinhtanphat2403` with that exact `BACKEND_ORIGIN` when necessary.
7. Verify `https://yupvox.qs3d.site/api/ready` reaches the same current backend schema/state.
8. Keep GitHub Actions CI-only; do not add an alternate GitHub production deployment workflow.

## Regression rules

The following are architecture regressions and should fail CI/review:

- putting `yupvox.qs3d.site` back into backend `wrangler.jsonc`;
- changing backend `account_id` back to the zone-owner account just to make Custom Domain attachment work;
- allowing `containers`, container Durable Objects, top-level lifecycle exports, or backend custom-domain routes into the generated production config;
- removing the zero-container Stream binding from the backend;
- reintroducing an FFmpeg/Separator Container binding or hidden fallback;
- moving D1/R2 production state into the gateway account accidentally;
- hard-coding a guessed `workers.dev` account subdomain;
- configuring `BACKEND_ORIGIN` to `https://yupvox.qs3d.site`, which would create a proxy loop;
- treating an unqualified optional provider as production-ready;
- letting GitHub Actions become a production deployment lane.

## Rollback

If the gateway rollout is wrong, roll back only the gateway Worker/config on `trinhtanphat2403`; do not move the `qs3d.site` zone or production D1/R2 state as a quick fix.

If the backend rollout is wrong, roll back the `dubflow` deployment on `trinhtanphat6666`, retain the gateway hostname on `trinhtanphat2403`, and point `BACKEND_ORIGIN` only to a backend version that has been explicitly verified.
