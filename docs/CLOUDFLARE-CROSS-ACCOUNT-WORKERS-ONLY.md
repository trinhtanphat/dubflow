# Cloudflare cross-account Workers-only production topology

Status: **canonical production architecture**

Last updated: 2026-09-07

## Goal

Keep the `qs3d.site` zone in the Cloudflare account that owns it while running the DubFlow backend in the separate account selected for Workers runtime. Paid Cloudflare Containers are intentionally disabled, and the admitted media runtime is R2-only with no Cloudflare Stream dependency.

## Account ownership

| Role | Cloudflare account | Account ID | Owns |
| --- | --- | --- | --- |
| Public zone / gateway | `trinhtanphat2403` | `50afb4fd3c4c7a1f3e1bdb7f22d4af7f` | `qs3d.site`, `yupvox.qs3d.site`, thin gateway Worker |
| DubFlow backend | `trinhtanphat6666` | `6c5207813df3d5b83b9508125e0e9e12` | `dubflow` Worker, D1, R2, Analytics Engine, Workers AI, Workflows, rate limits, provider state |

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

## Containers and Cloudflare Stream are disabled

Cloudflare Containers are **disabled in production** because this deployment intentionally avoids the paid Containers runtime. Cloudflare Stream is also **not part of the admitted media runtime**.

The backend `wrangler.jsonc` must not contain:

- `containers`
- Container-backed `durable_objects`
- Container `exports`
- `FFMPEG_CONTAINER` or `SEPARATOR_CONTAINER` bindings
- a Cloudflare Stream binding
- a runtime requirement for `CLOUDFLARE_STREAM_API_TOKEN`

The generated Workers Builds production config is created by `scripts/cloudflare-workers-build-config.mjs`. As defense in depth it strips `containers`, `durable_objects`, top-level `exports`, `stream`, and `routes` before deployment while preserving the backend account and R2/Workers bindings.

`Containers Edit` and Cloudflare Stream permissions are **not required** by the admitted production media runtime.

### Active R2-only media runtime

The active dubbed-media path is:

```text
private R2 source
  -> short-lived signed project-scoped R2 media URL
  -> remote ASR when supported (Deepgram for long-form)
  -> translation / ElevenLabs PCM TTS
  -> Worker-native PCM/WAV soundtrack assembly
  -> H.264/AVC encoded-video packet copy + AAC dubbed soundtrack
  -> fragmented MP4 remux with bounded multipart writes
  -> private canonical R2 export object
```

The canonical signing secret is `MEDIA_SOURCE_SIGNING_SECRET`. `STREAM_SOURCE_SIGNING_SECRET` is accepted only as a temporary migration alias while the live control-plane secret is moved to the canonical name. Secret values are managed in Cloudflare and are never committed.

Standard `dubbed_only` export admission performs a cheap source check before TTS. The supported baseline is one readable MP4 H.264/AVC video track that can be packet-copied without video decode/re-encode. Unsupported video fails closed with `VIDEO_TRANSCODE_REQUIRED`; there is no automatic Stream or Container fallback.

Ranged R2 reads and bounded multipart R2 writes keep long-form media off the whole-file `ArrayBuffer` path. The dubbed PCM/WAV soundtrack is encoded to AAC while the original H.264/AVC video packets are preserved through the remux path.

Legacy hybrid audio modes that still depend on dialogue separation remain fail-closed while no qualified zero-Container separation runtime is configured.

Visual lip-sync remains an optional provider path layered after the canonical standard dubbed export. It is admitted only when the provider is configured and runtime-qualified; standard output remains durable even if optional visual processing fails.

Do not restore paid Container or Cloudflare Stream bindings merely to make a media feature appear available. Any future runtime that changes these boundaries must be explicitly implemented, qualified, and documented.

## Backend deployment: `trinhtanphat6666`

Canonical config: `wrangler.jsonc`

Required properties:

- `account_id = 6c5207813df3d5b83b9508125e0e9e12`
- `name = dubflow`
- `workers_dev = true`
- no custom-domain route
- no Container/Durable Object deployment
- no Cloudflare Stream binding
- D1/R2/AI/Analytics/Workflow/rate-limit bindings stay on this account
- `PUBLIC_ORIGIN = https://yupvox.qs3d.site`
- media-source signing through `MEDIA_SOURCE_SIGNING_SECRET` or the temporary legacy alias during rollout

Cloudflare Workers Builds for `dubflow` watches `main`. The repository-owned production runner is `node scripts/cloudflare-workers-build-deploy.mjs`. It delegates config generation to `scripts/cloudflare-workers-build-config.mjs`, deploys `.wrangler-production.json`, applies remote D1 migrations, then verifies readiness.

GitHub Actions is CI only. It dry-runs both checked-in `wrangler.jsonc` and the exact generated `.wrangler-production.json`; it must not invoke the production deploy runner or perform a non-dry-run production deployment.

The backend readiness contract is schema revision **14**. A healthy admitted media runtime reports:

```json
{
  "ready": true,
  "database": "ready",
  "schemaRevision": 14,
  "media": {
    "r2": "ready",
    "remux": "ready"
  }
}
```

Historical Stream-named D1 columns and the already-shipped `0012_stream_media.sql` migration remain intact for migration lineage and backward-readable data only. They do not make Cloudflare Stream an active runtime dependency.

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

The canonical gateway Workers Builds deploy command is:

```text
node scripts/cloudflare-gateway-workers-build-deploy.mjs
```

The runner deploys the checked-in gateway config directly; it must not delete the custom-domain route, synthesize a second config, or force a different `workers_dev` value.

If `BACKEND_ORIGIN` is missing or invalid, the gateway returns HTTP 503 with `BACKEND_ORIGIN_UNAVAILABLE` instead of looping or forwarding to an unknown target.

## Deployment order

1. Merge a fully green source commit to `main`.
2. Let Cloudflare Workers Builds generate and deploy `.wrangler-production.json` in `trinhtanphat6666`.
3. Apply the remote D1 migration chain and pass readiness verification.
4. Confirm Wrangler reports the backend `workers.dev` URL.
5. Verify the backend directly at `<BACKEND_ORIGIN>/api/ready`: schema 14, `media.r2 = ready`, `media.remux = ready`.
6. Keep the gateway runtime `BACKEND_ORIGIN` pointed at that exact origin and keep `keep_vars = true` in `wrangler.gateway.jsonc`.
7. Let the normal `dubflow-gateway` Workers Builds lane in `trinhtanphat2403` deploy/update when necessary.
8. Verify `https://yupvox.qs3d.site/api/ready` reaches the same current backend schema/state.
9. Run one small supported H.264/AVC MP4 through upload -> dubbing -> standard export and verify the final MP4 is served from R2 with dubbed AAC audio and no Stream/Containers dependency.
10. Keep GitHub Actions CI-only; do not add an alternate GitHub production deployment workflow.

## Regression rules

The following are architecture regressions and should fail CI/review:

- putting `yupvox.qs3d.site` back into backend `wrangler.jsonc`;
- changing backend `account_id` back to the zone-owner account just to make Custom Domain attachment work;
- allowing `containers`, Container Durable Objects, top-level lifecycle exports, Stream bindings, or backend custom-domain routes into the generated production config;
- reintroducing an FFmpeg/Separator Container binding or hidden fallback;
- reintroducing `StreamMediaService`, `cloudflare/stream`, Stream ingest/download/publish API calls, or a required `CLOUDFLARE_STREAM_API_TOKEN` into active Worker code;
- allowing standard dubbed export to bypass early H.264/AVC remux admission and spend TTS before discovering `VIDEO_TRANSCODE_REQUIRED`;
- buffering multi-hour source/final media as one whole-file `ArrayBuffer` instead of ranged reads/bounded multipart writes;
- moving D1/R2 production state into the gateway account accidentally;
- hard-coding a guessed `workers.dev` account subdomain;
- disabling gateway runtime-variable preservation while `BACKEND_ORIGIN` remains configured outside source;
- configuring `BACKEND_ORIGIN` to `https://yupvox.qs3d.site`, which would create a proxy loop;
- treating an unqualified optional provider as production-ready;
- letting GitHub Actions become a production deployment lane;
- renaming or rewriting already-shipped D1 migration filenames to erase historical Stream lineage.

## Rollback

If the gateway rollout is wrong, roll back only the gateway Worker/config on `trinhtanphat2403`; do not move the `qs3d.site` zone or production D1/R2 state as a quick fix.

If the backend rollout is wrong, roll back the `dubflow` deployment on `trinhtanphat6666`, retain the gateway hostname on `trinhtanphat2403`, and point `BACKEND_ORIGIN` only to a backend version that has been explicitly verified.

Do not restore Cloudflare Stream or paid Containers as an emergency shortcut. Roll back to a known-good backend version instead.
