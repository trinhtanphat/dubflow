# YupVox deployment status

Canonical production hostname: `yupvox.qs3d.site`

Cloudflare account: `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`

Deployment is fail-closed. `npm run deploy` verifies source, runs a Wrangler dry run, deploys the Worker and Static Assets, applies D1 migrations by binding, and only reports success after `/api/ready` confirms the production schema exists.

GitHub Actions is enabled for this public repository. CI runs real dependency installation, tests, TypeScript/Vite build, a Wrangler dry-run, and captures a 1448×1086 headless Chromium screenshot from the exact tested SHA for Studio reference qualification. Production deployment is **manual-only** via `workflow_dispatch` while the Cloudflare Container credential is externally qualified. It requires the `CLOUDFLARE_API_TOKEN` GitHub secret. Because this deployment builds and pushes an FFmpeg Cloudflare Container, the token must include Cloudflare's **Containers Write** (or equivalent Containers Edit) permission in addition to the permissions needed for Workers and bound resources. The Cloudflare account ID is non-secret and pinned to the canonical account above.

The first live Container deploy attempt on the reconciled source proved the existing token can reach the Worker deployment path but returned `Unauthorized` when Wrangler moved into the Container image deployment. Until the token is replaced or updated with the required Container permission, do not treat production runtime as qualified and do not repeatedly auto-deploy `main`.

## Reconciled live dubbing source path

The current source implements:

```text
R2 multipart media upload
-> durable Cloudflare Workflow job
-> FFmpeg Cloudflare Container probe + bounded 5-minute audio chunks
-> Deepgram Nova-3 diarized ASR when DEEPGRAM_API_KEY is configured
   OR Workers AI Whisper fallback when it is absent
-> deterministic/atomic D1 speaker + transcript persistence
-> Workers AI translation by default
-> project/job terminal state
-> Studio poll + transcript/timeline hydration
-> server-backed transcript editing and retranslation
-> ElevenLabs segment TTS for export
-> FFmpeg dubbed-audio timeline assembly/mux
-> final R2 export artifact
```

Deepgram speaker identities are currently **chunk-scoped**. A speaker index returned in one 5-minute request is not assumed to be the same person as the same index in another chunk. Cross-chunk identity stitching therefore remains unqualified and is not represented as implemented.

Google Translation remains an optional configured provider. Compare mode does not persist a winner until the user explicitly applies it. Deepgram is also optional: without `DEEPGRAM_API_KEY`, the source falls back to Workers AI Whisper and `/api/ready` reports speaker diarization as unavailable while the base service can remain ready.

The deploy workflow supports optional `GOOGLE_CLOUD_TRANSLATE_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_DEFAULT_VOICE_ID` GitHub secrets and syncs configured values into Worker secrets without committing them.

Source support for final dubbed export now exists through the ElevenLabs + FFmpeg export workflow. This is still distinct from production-runtime qualification: the repository must not claim a deployed export PASS until a real fixture produces and returns the final artifact. Voice cloning and visual lip-sync rendering remain capability-gated and unqualified.

## Studio reference qualification

Desktop reference qualification uses the supplied 1448×1086 YupVox workstation reference, while the responsive fidelity layer also remains active on common 1364px desktop screens. The production shell activates the isolated `reference-fidelity` presentation layer and keeps the approved three-column workstation geometry.

The exact-head CI screenshot is reviewed as a presentation qualification, not as a claim of literal pixel identity. The supplied reference contains a real wuxia video frame and uploaded-media metadata; an empty source-media state must remain truthful rather than fabricating footage or an uploaded file. This media-state difference does not qualify as a production runtime fixture.

## Qualification status

A GREEN source CI and Wrangler dry-run qualify the repository source/configuration only. Production runtime PASS requires a real supported media fixture to traverse the deployed flow. For diarization qualification, the production fixture must be run with a valid `DEEPGRAM_API_KEY` and must return persisted speaker-linked segments. For final export qualification, a real ElevenLabs/FFmpeg run must write the final R2 artifact and make it retrievable through the export path.

If those live fixtures have not been executed successfully, runtime status remains **UNQUALIFIED** rather than PASS. Cloudflare, Google, Deepgram, and ElevenLabs secret values are never committed to the repository.
