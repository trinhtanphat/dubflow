# YupVox (DubFlow repo)

YupVox is a Cloudflare-first AI dubbing workstation. The repository remains `dubflow`; the production custom domain is **`yupvox.qs3d.site`**.

## Implemented source

- Studio Pro React + TypeScript workstation with responsive source/editor/inspector layout, accessibility controls, dual-language script editing, speaker rows and multi-track timeline.
- Source languages: auto / Chinese / English / Japanese / Korean. Vietnamese remains the legacy/default target; Phase 4C adds the exact target set Vietnamese (`vi`), English (`en`), Chinese (`zh`), Japanese (`ja`) and Korean (`ko`).
- 5 GB source-file limit and 3-hour product duration limit.
- Project creation plus bounded R2 multipart media upload; the Worker never buffers a complete 5 GB source body.
- Cloudflare Workflow-backed dubbing jobs with durable D1 progress/error state.
- FFmpeg Cloudflare Container media processing with bounded 300-second ASR windows and a 15-second overlap through R2.
- Optional Deepgram Nova-3 ASR with speaker diarization when `DEEPGRAM_API_KEY` is configured. Phase 4A adds conservative cross-chunk speaker stitching from duplicate utterances observed in adjacent overlap windows. A mapping is accepted only when segment and speaker evidence are unambiguous one-to-one matches; ambiguous or missing evidence remains chunk-scoped rather than guessed.
- Workers AI `@cf/openai/whisper-large-v3-turbo` remains the fallback ASR path when Deepgram is not configured. It benefits from overlap duplicate suppression but does not invent speaker identities or claim diarization.
- Normalized deterministic segment IDs/timestamps, conservative overlap de-duplication, speaker persistence, and atomic D1 transcript replacement.
- Workers AI translation using `@cf/meta/m2m100-1.2b` as the default processing path.
- Official Google Cloud Translation provider plus `workers-ai` / `google` / `compare` retranslation modes.
- Studio cloud orchestration: upload -> process -> poll durable job -> hydrate the persisted D1 project/timeline/transcript plus active speaker metadata.
- Server-backed transcript source/translation/speaker edits. Compare mode is non-destructive until the user explicitly applies one result.
- Persisted speaker display names and per-speaker ElevenLabs voice IDs. Changing a speaker voice invalidates that speaker's generated audio and dependent target exports; renaming alone does not discard valid audio.
- ElevenLabs-backed segment TTS and export workflow. Export uses a speaker's assigned ElevenLabs voice when present, otherwise the configured default voice; generated audio is stored in R2, assembled on the timeline by the FFmpeg media processor, and written as a downloadable artifact.
- Phase 4B source support adds explicit-consent ElevenLabs Instant Voice Clone (IVC) enrollment with owner-scoped lifecycle records, temporary R2 sample cleanup, provider deletion, `ready`-only speaker assignment, and a dedicated clone rate-limit lane. Professional Voice Clone training/verification orchestration remains out of scope.
- Phase 4C source support adds target-aware language configuration, translation variants, target-aware glossary context, dubbed/subtitle export attempts, batch export, target-scoped R2 artifacts, partial-success isolation, and concrete export sharing for `vi/en/zh/ja/ko`.
- Phase 4C Studio exposes target-language controls, target-bound transcript editing, truthful per-language state, and batch export controls. Canonical source/timing/speaker identity remains shared rather than duplicated per language.
- Completed Vietnamese output retains the legacy project-level export compatibility path while target-specific attempts remain independently addressable.
- Phase 3B usage accounting remains authoritative for provider work. `RATE_LIMIT_BATCH_EXPORT` is retained as a Cloudflare compatibility/admission binding and is not credits, pricing or a parallel billing ledger.
- Visual lip-sync remains capability-gated and is not claimed as implemented or production-qualified.
- `GET /api/ready` checks the production D1 schema and reports configured capability without exposing secret values.
- GitHub Actions verification CI installs dependencies, runs acceptance/unit tests, performs the TypeScript/Vite production build, runs Wrangler dry-run, and captures reference screenshots.

## Cloudflare target

Production account ID:

```text
6c5207813df3d5b83b9508125e0e9e12
```

Production custom domain:

```text
yupvox.qs3d.site
```

`wrangler.jsonc` uses Workers Static Assets with `/api/*` Worker-first routing, D1 binding `DB`, R2 binding `MEDIA`, Workers AI binding `AI`, Analytics Engine, rate-limit bindings, Cloudflare Workflow bindings for dubbing/export/language translation, and the `FFMPEG_CONTAINER` Durable Object/container binding.

## Resource provisioning

Wrangler supports automatic provisioning for draft D1/R2 bindings. This repository deliberately does not commit a fake account-specific D1 UUID or placeholder. Production resource ownership and deployment authorization are controlled by the Cloudflare project/account.

## CI and production deployment

GitHub Actions is **CI only**. It may install dependencies, test, build, run `wrangler deploy --dry-run`, and capture artifacts/screenshots. It must not perform a production Wrangler deploy, remote production migration, Worker secret mutation, or a second Cloudflare production deployment path.

**Cloudflare Workers Builds is the only production deployment lane.** `main` is the production source of truth: after an approved change is merged to `main`, Workers Builds owns the production build/deploy attempt for that exact commit.

`.github/workflows/deploy-cloudflare.yml` must not exist. Do not recreate a GitHub production deploy workflow to work around a Cloudflare failure.

Because the project deploys an FFmpeg Cloudflare Container, the API token configured in Cloudflare **Settings > Builds** must include the normal Worker/resource permissions plus **Containers Edit** for account `6c5207813df3d5b83b9508125e0e9e12`. Secret token values must never be committed.

Optional runtime providers use secrets such as:

```text
GOOGLE_CLOUD_TRANSLATE_API_KEY
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_DEFAULT_VOICE_ID
```

If Deepgram is not configured, YupVox falls back to Workers AI Whisper and does not claim speaker diarization. If ElevenLabs is not configured or its language capability is unqualified/unsupported, dubbed export must fail closed rather than fabricate support; subtitle export remains independently admissible when its own prerequisites are satisfied.

See `docs/DEPLOYMENT-POLICY.md` and `docs/deployment-status.md` for the authoritative deployment and qualification boundary.

## Local validation

Install dependencies and run the same source gates used by CI:

```bash
npm install
npm run verify
npx wrangler deploy --dry-run
```

These commands qualify source/build configuration only. They do not constitute production deployment or runtime qualification.

## Qualification boundary

Source CI proves that the current Container/Workflow/API/UI integration builds and passes its automated contracts. It is **not** by itself a production-runtime dubbing PASS.

Production runtime qualification requires a real authorized media/provider fixture to complete the configured path, including:

```text
R2 multipart upload
-> Cloudflare Workflow
-> FFmpeg overlapping 300-second ASR analysis windows
-> Deepgram diarized ASR when configured, otherwise Workers AI Whisper
-> conservative overlap de-duplication and evidence-based speaker stitching
-> persisted D1 speakers/segments
-> target-aware translation
-> Studio transcript/timeline/speaker/language hydration
-> per-speaker ElevenLabs TTS when qualified
-> target-aware FFmpeg timeline assembly or subtitle serialization
-> final R2 artifact
-> owner retrieval / concrete share retrieval
```

Until a real deployed fixture succeeds, production runtime remains **UNQUALIFIED** even when source CI is GREEN.

Phase 4A source tests qualify the bounded-overlap/stitching algorithm, but production cross-chunk diarization remains unqualified until a real deployed Deepgram/media fixture demonstrates the intended identity behavior.

Phase 4B is source/CI qualification only. Managed ElevenLabs IVC enrollment requires explicit current rights/consent acknowledgement and a user-supplied audio sample; YupVox does not auto-extract source-video speech for cloning. Temporary enrollment samples are deleted after the provider attempt, and provider verification-required clones are not assignable. A real authorized provider fixture is still required before production voice cloning can be called qualified.

Phase 4C is also **source/CI qualification only**. Automated tests qualify the exact five-language authority, canonical/variant separation, target-aware translation context, CAS/conflict behavior, per-target export isolation, subtitles, voice fail-closed admission, concrete export sharing, Vietnamese compatibility and Studio controls. Source CI does not prove that real configured translation, ElevenLabs TTS and FFmpeg rendering have succeeded across multiple languages. A later runtime qualification requires a real authorized fixture with at least two distinct supported targets end-to-end.

Phase 4C implementation in this lane does **not** perform a production deployment. Merging source to `main` may trigger the repository's normal Cloudflare Workers Builds production lane, but runtime remains unqualified until the separate real-fixture qualification succeeds.

## Safety / truthfulness boundaries

- Managed Voice Clone enrollment requires explicit current rights/consent acknowledgement; do not infer consent from project ownership, diarization identity, speaker names, or source-video presence.
- Do not auto-extract source-video audio into the voice-clone workflow; the user must intentionally provide the enrollment sample.
- Do not label a clone usable until the server lifecycle is `ready`; `verification_required`, `creating`, `failed`, `deleting`, and `deleted` are non-assignable.
- Do not claim Professional Voice Clone creation/training/verification from Phase 4B IVC support.
- Do not mark a production dubbed export PASS until a deployed fixture has actually written and returned the final artifact.
- Do not claim Phase 4C multi-language runtime PASS from source CI, Wrangler dry-run, screenshots or deployment alone.
- Do not treat `RATE_LIMIT_BATCH_EXPORT` as usage accounting, credits, pricing or billing state.
- Do not claim visual lip-sync rendering from duration fitting or audio timeline assembly alone.
- Do not merge cross-chunk speakers from matching numeric speaker indexes, text alone, names, or guesses; only the conservative overlap-evidence contract may stitch identities, and ambiguous evidence must remain split.
- Do not present Phase 4A source/CI qualification as production diarization qualification.
- Do not send the complete source file through one Worker request; use the multipart API.
- Do not commit Cloudflare, Google, Deepgram, ElevenLabs, or other secret credentials.
