# Cloudflare cross-account Workers-only production topology

Status: **canonical production architecture**

Last updated: 2026-09-07

## Goal

Keep the `qs3d.site` zone in the Cloudflare account that owns it while running the DubFlow backend in the separate account selected for Workers runtime. Paid Cloudflare Containers are intentionally disabled.

## Account ownership

| Role | Cloudflare account | Account ID | Owns |
| --- | --- | --- | --- |
| Public zone / gateway | `trinhtanphat2403` | `50afb4fd3c4c7a1f3e1bdb7f22d4af7f` | `qs3d.site`, `yupvox.qs3d.site`, thin gateway Worker |
| DubFlow backend | `trinhtanphat6666` | `6c5207813df3d5b83b9508125e0e9e12` | `dubflow` Worker, D1, R2, Analytics Engine, Workers AI, Workflows, rate limits |

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
   `- rate limits
```

`wrangler.gateway.jsonc` is the only checked-in Wrangler config allowed to attach the public custom domain. `wrangler.jsonc` is the backend config and intentionally has no `routes`; it exposes the backend through `workers.dev` instead.

## Containers are disabled

Cloudflare Containers are **disabled in production** because this deployment intentionally avoids the paid Containers runtime.

The backend `wrangler.jsonc` must not contain:

- `containers`
- Container-backed `durable_objects`
- Container `exports`
- `FFMPEG_CONTAINER` or `SEPARATOR_CONTAINER` bindings

The source adapters and Docker/test fixtures may remain in the repository for future reuse, but they are not bound or deployed by the production Worker. Their presence in source does not make a Container run.

`Containers Edit` is **not required** for the production Workers Builds token while this topology remains in force.

### Runtime capability boundary without Containers

The current source uses the optional FFmpeg/Demucs container adapters for media probe/extraction/rendering and dialogue separation. With production bindings removed, those paths must remain fail-closed rather than silently pretending to work.

Consequences until a non-Container media backend is implemented:

- upload/storage, project CRUD, D1/R2 state, UI, translation/context APIs, observability and other Worker-native paths can remain available;
- media operations that require `FFMPEG_CONTAINER` return the existing `MEDIA_PROCESSOR_UNAVAILABLE` failure boundary;
- dialogue separation remains unqualified/unavailable because `SEPARATOR_CONTAINER` is absent and `SEPARATION_RUNTIME_QUALIFIED` stays `false`;
- source FFmpeg/Demucs tests are source qualification only and do not imply a deployed Container.

Do not restore paid Container bindings merely to make a media feature appear available. A future replacement should be implemented and qualified explicitly.

## Backend deployment: `trinhtanphat6666`

Canonical config: `wrangler.jsonc`

Required properties:

- `account_id = 6c5207813df3d5b83b9508125e0e9e12`
- `name = dubflow`
- `workers_dev = true`
- no custom-domain route
- no Container/Durable Object deployment
- D1/R2/AI/Analytics/Workflow/rate-limit bindings stay on this account

Cloudflare Workers Builds for `dubflow` watches `main`. The build command remains `npm run build`. The direct deploy command `npx wrangler deploy` is valid for this backend config because it no longer attempts to claim a zone from another account and no longer attempts to publish Containers.

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

`BACKEND_ORIGIN` is deliberately not committed into source. `wrangler.gateway.jsonc` therefore keeps `keep_vars = true` so a runtime value configured through Cloudflare survives later automatic Wrangler/Workers Builds deployments instead of being replaced just because it is absent from the checked-in config.

Example deployment after resolving the exact origin:

```bash
npx wrangler deploy --config wrangler.gateway.jsonc --var BACKEND_ORIGIN:https://dubflow.<exact-6666-account-subdomain>.workers.dev
```

Equivalent configuration through the Cloudflare dashboard is acceptable. The source intentionally has no guessed default; if `BACKEND_ORIGIN` is missing or invalid, the gateway returns HTTP 503 with `BACKEND_ORIGIN_UNAVAILABLE` instead of looping or forwarding to an unknown target.

## Deployment order

1. Merge a fully green source commit to `main`.
2. Let Cloudflare Workers Builds deploy `wrangler.jsonc` in `trinhtanphat6666`.
3. Confirm Wrangler reports the backend `workers.dev` URL.
4. Verify the backend directly at `<BACKEND_ORIGIN>/api/ready`.
5. Configure the gateway runtime `BACKEND_ORIGIN` to that exact origin; keep `keep_vars = true` in `wrangler.gateway.jsonc`.
6. Deploy/update `dubflow-gateway` in `trinhtanphat2403`.
7. Verify `https://yupvox.qs3d.site/api/ready` reaches the same backend schema/state.
8. Keep GitHub Actions CI-only; do not add an alternate GitHub production deployment workflow.

## Regression rules

The following are architecture regressions and should fail CI/review:

- putting `yupvox.qs3d.site` back into backend `wrangler.jsonc`;
- changing backend `account_id` back to the zone-owner account just to make Custom Domain attachment work;
- restoring `containers`, container Durable Objects, or Container exports to production config without an explicit paid-runtime decision;
- moving D1/R2 production state into the gateway account accidentally;
- hard-coding a guessed `workers.dev` account subdomain;
- disabling gateway runtime-variable preservation while `BACKEND_ORIGIN` remains configured outside source;
- configuring `BACKEND_ORIGIN` to `https://yupvox.qs3d.site`, which would create a proxy loop;
- claiming FFmpeg/Demucs production qualification while their Container bindings are disabled.

## Rollback

If the gateway rollout is wrong, roll back only the gateway Worker/config on `trinhtanphat2403`; do not move the `qs3d.site` zone or production D1/R2 state as a quick fix.

If the backend rollout is wrong, roll back the `dubflow` deployment on `trinhtanphat6666`, retain the gateway hostname on `trinhtanphat2403`, and point `BACKEND_ORIGIN` only to a backend version that has been explicitly verified.
