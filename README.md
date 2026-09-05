# YupVox (DubFlow repo)

YupVox is a Cloudflare-first AI dubbing workstation. The repository remains `dubflow`; the production custom domain is **`yupvox.qs3d.site`**.

## Implemented source

- Studio Pro V2.1 React + TypeScript workstation with responsive source/editor/inspector layout, accessibility controls, dual-language script editing, speaker rows and multi-track timeline.
- Source languages: auto / Chinese / English / Japanese / Korean; initial target: Vietnamese.
- 5 GB source-file limit and 3-hour product duration limit.
- Project creation plus bounded R2 multipart media upload; the Worker never buffers a complete 5 GB source body.
- Cloudflare Workflow-backed dubbing jobs with durable D1 progress/error state.
- FFmpeg Cloudflare Container media processor that probes the source and emits bounded standalone 5-minute audio chunks through R2.
- Workers AI ASR with `@cf/openai/whisper-large-v3-turbo`, normalized deterministic segment IDs/timestamps, and atomic D1 transcript replacement.
- Workers AI translation using `@cf/meta/m2m100-1.2b` as the default processing path.
- Official Google Cloud Translation provider plus `workers-ai` / `google` / `compare` retranslation modes.
- Studio Pro cloud orchestration: upload -> process -> poll durable job -> hydrate the persisted D1 project/timeline/transcript.
- Server-backed transcript source/translation/speaker edits. Compare mode is non-destructive until the user explicitly applies one result.
- Voice provider boundary that **does not** claim Vietnamese TTS, voice cloning, visual lip-sync rendering, or final dubbed export until those capabilities are independently live-qualified.
- `GET /api/ready` checks that the production D1 `projects` schema exists before deployment readiness is reported.
- GitHub Actions verification CI runs a real dependency install, tests, TypeScript/Vite build, and Wrangler dry-run.

## Cloudflare target

Account ID:

```text
50afb4fd3c4c7a1f3e1bdb7f22d4af7f
```

Production custom domain:

```text
yupvox.qs3d.site
```

`wrangler.jsonc` uses Workers Static Assets with `/api/*` running Worker-first, D1 binding `DB`, R2 binding `MEDIA`, Workers AI binding `AI`, Cloudflare Workflow binding `DUBBING_WORKFLOW`, and the `FFMPEG_CONTAINER` Durable Object/container binding.

## Automatic resource provisioning

Wrangler 4.45+ supports automatic provisioning for draft D1/R2 bindings. This repository deliberately does not commit an account-specific D1 UUID or fake placeholder. On authenticated deploy Wrangler creates/link missing resources according to the current config.

## GitHub Actions

`.github/workflows/ci.yml` runs on pushes and pull requests and performs a real dependency install, test suite, TypeScript/Vite production build, and Wrangler dry-run.

`.github/workflows/deploy-cloudflare.yml` runs on pushes to `main` and can also be launched manually with `workflow_dispatch`. Production deployment is fail-closed and requires this GitHub Actions secret:

```text
CLOUDFLARE_API_TOKEN
```

The Cloudflare account ID is non-secret and pinned both in `wrangler.jsonc` and the deploy workflow. Never commit the token itself.

Optional Google translation support can use this GitHub Actions secret:

```text
GOOGLE_CLOUD_TRANSLATE_API_KEY
```

When present, the deploy workflow syncs it into the Worker secret named `GOOGLE_CLOUD_TRANSLATE_API_KEY`. If absent, YupVox retains the default Workers AI translation path while the Google provider reports itself unavailable.

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

## Qualification boundary

Source CI proves that the current Container/Workflow/API/UI integration builds and passes its automated contracts. It is **not** by itself a production-runtime dubbing PASS.

Production runtime qualification requires a real supported media fixture to complete:

```text
R2 multipart upload
-> Cloudflare Workflow
-> FFmpeg 5-minute chunks
-> Whisper ASR
-> persisted D1 segments
-> Workers AI translation
-> Studio Pro transcript/timeline hydration
```

Until that real deployed fixture succeeds, production runtime remains unqualified even when source CI is GREEN.

## Safety / truthfulness boundaries

- Do not enable or label voice cloning unless a configured provider explicitly supports cloning and the operator has rights/consent for the source voice.
- Do not mark final dubbed export complete until a qualified media/voice rendering pipeline has actually written the artifact.
- Do not claim visual lip-sync rendering from duration fitting alone.
- Do not send the complete source file through one Worker request; use the multipart API.
- Do not commit Cloudflare or Google secrets.
