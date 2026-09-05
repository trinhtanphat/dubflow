# YupVox (DubFlow repo)

YupVox is a Cloudflare-first AI dubbing workstation. The repository remains `dubflow`; the production custom domain is **`yupvox.qs3d.site`**.

## Implemented source

- Studio Pro React + TypeScript workstation with responsive source/editor/inspector layout, accessibility controls, dual-language script editing, speaker rows and multi-track timeline.
- Source languages: auto / Chinese / English / Japanese / Korean; initial target: Vietnamese.
- 5 GB source-file limit and 3-hour product duration limit.
- Project creation plus bounded R2 multipart media upload; the Worker never buffers a complete 5 GB source body.
- Cloudflare Workflow-backed dubbing jobs with durable D1 progress/error state.
- FFmpeg Cloudflare Container media processor that probes the source and emits bounded standalone 5-minute audio chunks through R2.
- Optional Deepgram Nova-3 ASR with speaker diarization when `DEEPGRAM_API_KEY` is configured. The current persisted speaker identity is deliberately **chunk-scoped**; the source does not claim cross-chunk speaker identity stitching.
- Workers AI `@cf/openai/whisper-large-v3-turbo` remains the fallback ASR path when Deepgram is not configured; that fallback does not claim speaker diarization.
- Normalized deterministic segment IDs/timestamps, speaker persistence, and atomic D1 transcript replacement.
- Workers AI translation using `@cf/meta/m2m100-1.2b` as the default processing path.
- Official Google Cloud Translation provider plus `workers-ai` / `google` / `compare` retranslation modes.
- Studio cloud orchestration: upload -> process -> poll durable job -> hydrate the persisted D1 project/timeline/transcript.
- Server-backed transcript source/translation/speaker edits. Compare mode is non-destructive until the user explicitly applies one result.
- ElevenLabs-backed segment TTS boundary and export workflow. The export source generates dubbed segment audio, stores it in R2, asks the FFmpeg media processor to assemble the timeline, and writes a final downloadable media artifact.
- Voice cloning and visual lip-sync remain capability-gated and are not claimed as implemented or production-qualified.
- `GET /api/ready` checks that the production D1 `projects` schema exists and reports the configured ASR/diarization capability without exposing secret values.
- GitHub Actions verification CI runs a real dependency install, tests, TypeScript/Vite build, Wrangler dry-run, and reference screenshot capture.

## Cloudflare target

Account ID:

```text
50afb4fd3c4c7a1f3e1bdb7f22d4af7f
```

Production custom domain:

```text
yupvox.qs3d.site
```

`wrangler.jsonc` uses Workers Static Assets with `/api/*` running Worker-first, D1 binding `DB`, R2 binding `MEDIA`, Workers AI binding `AI`, Cloudflare Workflow bindings for dubbing/export, and the `FFMPEG_CONTAINER` Durable Object/container binding.

## Automatic resource provisioning

Wrangler 4.45+ supports automatic provisioning for draft D1/R2 bindings. This repository deliberately does not commit an account-specific D1 UUID or fake placeholder. On authenticated deploy Wrangler creates/link missing resources according to the current config.

## GitHub Actions

`.github/workflows/ci.yml` runs on pushes and pull requests and performs a real dependency install, test suite, TypeScript/Vite production build, Wrangler dry-run, and reference screenshot capture.

`.github/workflows/deploy-cloudflare.yml` is currently **manual-only** via `workflow_dispatch`. This prevents repeated partial production deploys while the Cloudflare Container credential is being qualified. Production deployment is fail-closed and requires this GitHub Actions secret:

```text
CLOUDFLARE_API_TOKEN
```

Because YupVox deploys an FFmpeg Cloudflare Container, the token must include **Containers Write** (or equivalent Containers Edit) in addition to the permissions needed for Workers and the bound D1/R2/AI resources. The Cloudflare account ID is non-secret and pinned both in `wrangler.jsonc` and the deploy workflow. Never commit the token itself.

Optional providers use these GitHub Actions secrets:

```text
GOOGLE_CLOUD_TRANSLATE_API_KEY
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_DEFAULT_VOICE_ID
```

When present, the deploy workflow syncs the corresponding values into Worker secrets. If `DEEPGRAM_API_KEY` is absent, YupVox falls back to Workers AI Whisper and reports speaker diarization as unavailable. If the ElevenLabs credentials are absent, source support exists but export must fail closed rather than fabricate dubbed audio.

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

A deployment is not reported ready until the custom domain responds successfully **and** the D1 `projects` table exists. ASR capability metadata is informational and does not make the whole service unready when the optional Deepgram provider is absent.

## Qualification boundary

Source CI proves that the current Container/Workflow/API/UI integration builds and passes its automated contracts. It is **not** by itself a production-runtime dubbing PASS.

Production runtime qualification requires a real supported media fixture to complete the configured path, including:

```text
R2 multipart upload
-> Cloudflare Workflow
-> FFmpeg 5-minute chunks
-> Deepgram diarized ASR when configured, otherwise Workers AI Whisper
-> persisted D1 speakers/segments
-> Workers AI or configured translation
-> Studio transcript/timeline hydration
-> ElevenLabs segment TTS for export
-> FFmpeg timeline assembly/mux
-> final R2 export artifact
```

Until that real deployed fixture succeeds, production runtime remains unqualified even when source CI is GREEN. Cross-chunk speaker identity is also explicitly outside the current diarization qualification.

## Safety / truthfulness boundaries

- Do not enable or label voice cloning unless a configured provider explicitly supports cloning and the operator has rights/consent for the source voice.
- Do not mark a production dubbed export PASS until a deployed fixture has actually written and returned the final artifact.
- Do not claim visual lip-sync rendering from duration fitting or audio timeline assembly alone.
- Do not claim that chunk-local diarization proves the same speaker identity across multiple 5-minute chunks.
- Do not send the complete source file through one Worker request; use the multipart API.
- Do not commit Cloudflare, Google, Deepgram, or ElevenLabs secrets.
