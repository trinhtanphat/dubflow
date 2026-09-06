# YupVox (DubFlow repo)

YupVox is a Cloudflare-first AI dubbing workstation. The repository remains `dubflow`; the production custom domain is **`yupvox.qs3d.site`**.

## Implemented source

- Studio Pro React + TypeScript workstation with responsive source/editor/inspector layout, accessibility controls, dual-language script editing, speaker rows and multi-track timeline.
- Source languages: auto / Chinese / English / Japanese / Korean; initial target: Vietnamese.
- 5 GB source-file limit and 3-hour product duration limit.
- Project creation plus bounded R2 multipart media upload; the Worker never buffers a complete 5 GB source body.
- Cloudflare Workflow-backed dubbing jobs with durable D1 progress/error state.
- FFmpeg Cloudflare Container media processor that probes the source and emits bounded 300-second ASR analysis windows with an 8-second overlap through R2.
- Optional Deepgram Nova-3 ASR with speaker diarization when `DEEPGRAM_API_KEY` is configured. Phase 4A adds conservative cross-chunk speaker stitching from duplicate utterances observed in adjacent overlap windows. A mapping is accepted only when segment evidence and speaker evidence are unambiguous one-to-one matches; ambiguous or missing evidence remains chunk-scoped rather than guessed.
- Workers AI `@cf/openai/whisper-large-v3-turbo` remains the fallback ASR path when Deepgram is not configured. It benefits from overlap duplicate suppression but does not invent speaker identities or claim diarization.
- Normalized deterministic segment IDs/timestamps, conservative overlap de-duplication, speaker persistence, and atomic D1 transcript replacement.
- Workers AI translation using `@cf/meta/m2m100-1.2b` as the default processing path.
- Official Google Cloud Translation provider plus `workers-ai` / `google` / `compare` retranslation modes.
- Studio cloud orchestration: upload -> process -> poll durable job -> hydrate the persisted D1 project/timeline/transcript plus active speaker metadata.
- Server-backed transcript source/translation/speaker edits. Compare mode is non-destructive until the user explicitly applies one result.
- Persisted speaker display names and per-speaker ElevenLabs voice IDs. Changing a speaker voice invalidates only that speaker's generated dubbed clips plus the stale final export; renaming alone does not discard valid audio.
- ElevenLabs-backed segment TTS and export workflow. Export uses a speaker's assigned ElevenLabs voice when present, otherwise the configured default voice; generated audio is stored in R2, assembled on the timeline by the FFmpeg media processor, and written as a final downloadable artifact.
- Phase 4B source support adds explicit-consent ElevenLabs Instant Voice Clone (IVC) enrollment with owner-scoped lifecycle records, temporary R2 sample cleanup, provider deletion, `ready`-only speaker assignment, and a dedicated clone rate-limit lane. Professional Voice Clone training/verification orchestration remains out of scope.
- Visual lip-sync remains capability-gated and is not claimed as implemented or production-qualified.
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

When present, the deploy workflow syncs the corresponding values into Worker secrets. If `DEEPGRAM_API_KEY` is absent, YupVox falls back to Workers AI Whisper and reports speaker diarization as unavailable. If the ElevenLabs credentials are absent, source support exists but export and managed IVC enrollment must fail closed rather than fabricate dubbed audio or clone capability.

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
-> FFmpeg overlapping 300-second ASR analysis windows
-> Deepgram diarized ASR when configured, otherwise Workers AI Whisper
-> conservative overlap de-duplication and evidence-based speaker stitching
-> persisted D1 speakers/segments
-> Workers AI or configured translation
-> Studio transcript/timeline/speaker hydration
-> per-speaker ElevenLabs TTS routing when voice IDs are assigned
-> FFmpeg timeline assembly/mux
-> final R2 export artifact
```

Until that real deployed fixture succeeds, production runtime remains **UNQUALIFIED** even when source CI is GREEN. Phase 4A source tests can qualify the stitching algorithm and bounded-overlap contracts, but production cross-chunk diarization remains unqualified until a real deployed Deepgram/media fixture demonstrates the intended identity behavior. Source-level per-speaker voice routing is likewise not a production PASS until verified on a real deployed export.

Phase 4B is also source/CI qualification only. Managed ElevenLabs IVC enrollment requires an explicit current rights/consent acknowledgement and a user-supplied audio sample; YupVox does not auto-extract source-video speech for cloning. Temporary enrollment samples are deleted after the provider attempt, and provider verification-required clones are not assignable. A real authorized provider fixture is still required before production voice cloning can be called qualified. Production deployment remains **manual-only** and Phase 4B does not trigger it.

## Safety / truthfulness boundaries

- Managed Voice Clone enrollment requires explicit current rights/consent acknowledgement; do not infer consent from project ownership, diarization identity, speaker names, or source-video presence.
- Do not auto-extract source-video audio into the voice-clone workflow; the user must intentionally provide the enrollment sample.
- Do not label a clone usable until the server lifecycle is `ready`; `verification_required`, `creating`, `failed`, `deleting`, and `deleted` are non-assignable.
- Do not claim Professional Voice Clone creation/training/verification from Phase 4B IVC support.
- Do not mark a production dubbed export PASS until a deployed fixture has actually written and returned the final artifact.
- Do not claim visual lip-sync rendering from duration fitting or audio timeline assembly alone.
- Do not merge cross-chunk speakers from matching numeric speaker indexes, text alone, names, or guesses; only the conservative overlap-evidence contract may stitch identities, and ambiguous evidence must remain split.
- Do not present Phase 4A source/CI qualification as production diarization qualification.
- Do not send the complete source file through one Worker request; use the multipart API.
- Do not commit Cloudflare, Google, Deepgram, or ElevenLabs secrets.
