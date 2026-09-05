# YupVox (DubFlow repo)

YupVox is a Cloudflare-first AI dubbing workstation. The repository remains `dubflow`; the production custom domain is configured as **`yupvox.qs3d.site`** (DNS hostnames are case-insensitive).

## Implemented source

- React + TypeScript dubbing workstation UI with dual-language script editor, speaker rows and multi-track timeline.
- Source languages: auto / Chinese / English / Japanese / Korean; initial target: Vietnamese.
- 5 GB source-file limit and 3-hour product duration limit.
- Cloudflare Worker API with D1 project storage and R2 multipart upload (25 MiB recommended parts; the Worker never buffers a 5 GB source body).
- Persisted segment repository/edit API.
- Workers AI translation provider using `@cf/meta/m2m100-1.2b`.
- Official Google Cloud Translation v2 provider and `workers-ai` / `google` / `compare` routing.
- Workers AI ASR adapter using `@cf/openai/whisper-large-v3-turbo` in `transcribe` mode with VAD.
- Voice provider boundary that **does not claim Vietnamese TTS or voice cloning** until a live capability check explicitly verifies it.
- Media-processing boundary that reports `MEDIA_PROCESSOR_UNAVAILABLE` until an FFmpeg Cloudflare Container is actually configured; export is never faked.
- No GitHub Actions. `.github/workflows` is forbidden by a repository guard.

## Cloudflare target

Account ID is configured in `wrangler.jsonc`:

```text
6c5207813df3d5b83b9508125e0e9e12
```

Worker custom domain:

```text
yupvox.qs3d.site
```

`wrangler.jsonc` uses Workers Static Assets with `/api/*` running Worker-first, plus bindings for D1 (`DB`), R2 (`MEDIA`) and Workers AI (`AI`).

## One-time Cloudflare resource setup

Authenticate Wrangler from a machine/session that can access Cloudflare:

```bash
npx wrangler login
```

Create resources:

```bash
npx wrangler d1 create dubflow-db
npx wrangler r2 bucket create dubflow-media
```

Copy the D1 UUID returned by `wrangler d1 create` into `wrangler.jsonc`, replacing:

```text
REPLACE_WITH_D1_DATABASE_ID
```

Apply the schema:

```bash
npx wrangler d1 migrations apply dubflow-db --remote
```

Google translation uses the **official** Cloud Translation API. Store the credential only as a Cloudflare secret:

```bash
npx wrangler secret put GOOGLE_CLOUD_TRANSLATE_API_KEY
```

Then verify and deploy:

```bash
npm install
npm run verify
npx wrangler deploy
```

The custom-domain declaration makes Cloudflare attach the Worker to `yupvox.qs3d.site` and manage the DNS/certificate when the hostname is eligible.

## Safety / truthfulness boundaries

- Do not enable or label voice cloning unless a configured provider explicitly supports cloning and the operator has rights/consent for the source voice.
- Do not mark export complete until the FFmpeg media processor has actually rendered and written the artifact.
- Do not send the complete source file through one Worker request; use the multipart API.
- Do not commit Cloudflare or Google secrets.
