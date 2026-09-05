# YupVox (DubFlow repo)

YupVox is a Cloudflare-first AI dubbing workstation. The repository remains `dubflow`; the production custom domain is **`yupvox.qs3d.site`**.

## Implemented source

- React + TypeScript dubbing workstation UI with dual-language script editor, speaker rows and multi-track timeline.
- Source languages: auto / Chinese / English / Japanese / Korean; initial target: Vietnamese.
- 5 GB source-file limit and 3-hour product duration limit.
- Cloudflare Worker API with D1 project storage and R2 multipart upload; the Worker never buffers a 5 GB source body.
- Persisted segment repository/edit API.
- Workers AI translation provider using `@cf/meta/m2m100-1.2b`.
- Official Google Cloud Translation provider and `workers-ai` / `google` / `compare` routing.
- Workers AI ASR adapter using `@cf/openai/whisper-large-v3-turbo`.
- Voice provider boundary that **does not** claim Vietnamese TTS or voice cloning until a live capability check explicitly verifies it.
- Media-processing boundary that reports `MEDIA_PROCESSOR_UNAVAILABLE` until an FFmpeg Cloudflare Container is actually configured; export is never faked.
- `GET /api/ready` checks that the production D1 `projects` schema exists before the deployment is considered ready.
- GitHub Actions verification CI is enabled for this public repository.

## Cloudflare target

Account ID:

```text
6c5207813df3d5b83b9508125e0e9e12
```

Production custom domain:

```text
yupvox.qs3d.site
```

`wrangler.jsonc` uses Workers Static Assets with `/api/*` running Worker-first, D1 binding `DB`, R2 binding `MEDIA`, and Workers AI binding `AI`.

## Automatic resource provisioning

Wrangler 4.45+ supports automatic provisioning for draft D1/R2 bindings. This repository deliberately does not commit an account-specific D1 UUID or fake placeholder. On first authenticated deploy Wrangler creates the missing resources and links them to the Worker.

## GitHub Actions

`.github/workflows/ci.yml` runs on pushes and pull requests and performs a real dependency install, test suite, TypeScript/Vite production build, and Wrangler dry-run.

`.github/workflows/deploy-cloudflare.yml` is **manual-only** (`workflow_dispatch`) in the current phase. It does not run automatically on every `main` push. To launch it, configure this GitHub Actions secret first:

```text
CLOUDFLARE_API_TOKEN
```

The Cloudflare account ID is already pinned in `wrangler.jsonc` and in the deploy workflow, so it is not treated as a secret.

Cloudflare recommends an API token scoped to the target account/zone with the permissions required to edit Workers and the bound resources. Never commit the token itself.

Optional Google translation support can use this GitHub Actions secret:

```text
GOOGLE_CLOUD_TRANSLATE_API_KEY
```

When present, the manual deploy workflow syncs it into the Worker secret named `GOOGLE_CLOUD_TRANSLATE_API_KEY`. If absent, YupVox still retains the Workers AI translation path and the Google provider remains unavailable until configured.

## Local deployment

Authenticate once:

```bash
npx wrangler login
```

Then:

```bash
npm install
npm run deploy
```

The fail-closed deploy sequence is:

1. `npm run verify`
2. `wrangler deploy --dry-run`
3. `wrangler deploy`
4. `wrangler d1 migrations apply DB --remote`
5. readiness polling at `https://yupvox.qs3d.site/api/ready`

A deployment is not reported ready until the custom domain responds successfully **and** the D1 `projects` table exists.

## Safety / truthfulness boundaries

- Do not enable or label voice cloning unless a configured provider explicitly supports cloning and the operator has rights/consent for the source voice.
- Do not mark export complete until the FFmpeg media processor has actually rendered and written the artifact.
- Do not send the complete source file through one Worker request; use the multipart API.
- Do not commit Cloudflare or Google secrets.
