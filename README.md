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
- Voice provider boundary that does **not** claim Vietnamese TTS or voice cloning until a live capability check explicitly verifies it.
- Media-processing boundary that reports `MEDIA_PROCESSOR_UNAVAILABLE` until an FFmpeg Cloudflare Container is actually configured; export is never faked.
- `GET /api/ready` checks that the production D1 `projects` schema exists before the deployment is considered ready.
- No GitHub Actions. `.github/workflows` is forbidden by a repository guard.

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

## Deployment

Wrangler 4.45+ supports automatic provisioning for draft D1/R2 bindings. This repository deliberately does not commit an account-specific D1 UUID or a fake placeholder. On first deploy Wrangler provisions the missing resources and links them to the Worker.

Authenticate once from a machine/session with Cloudflare access:

```bash
npx wrangler login
```

Install dependencies:

```bash
npm install
```

Optional Google translation support uses the official Cloud Translation API. Store the credential only as a Cloudflare secret:

```bash
npx wrangler secret put GOOGLE_CLOUD_TRANSLATE_API_KEY
```

Run the fail-closed deployment pipeline:

```bash
npm run deploy
```

The deploy command executes, in order:

1. `npm run verify`
2. `wrangler deploy --dry-run`
3. `wrangler deploy` — first deployment automatically provisions missing D1/R2 resources
4. `wrangler d1 migrations apply DB --remote`
5. readiness polling against `https://yupvox.qs3d.site/api/ready`

A deployment is not reported ready until the custom domain responds successfully **and** the D1 `projects` table exists.

For a raw Wrangler deployment without the repository verification/migration/readiness gate:

```bash
npm run deploy:raw
```

Use `deploy:raw` only for diagnostics; production delivery should use `npm run deploy`.

## Safety / truthfulness boundaries

- Do not enable or label voice cloning unless a configured provider explicitly supports cloning and the operator has rights/consent for the source voice.
- Do not mark export complete until the FFmpeg media processor has actually rendered and written the artifact.
- Do not send the complete source file through one Worker request; use the multipart API.
- Do not commit Cloudflare or Google secrets.
