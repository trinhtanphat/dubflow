# YupVox deployment status

Canonical public hostname: `yupvox.qs3d.site`

## Current Cloudflare topology

Production is intentionally split across two Cloudflare accounts.

- Public zone/gateway: `trinhtanphat2403` — `50afb4fd3c4c7a1f3e1bdb7f22d4af7f`. This account owns `qs3d.site`, the `yupvox.qs3d.site` custom domain, TLS, and the thin `dubflow-gateway` Worker.
- Backend/state: `trinhtanphat6666` — `6c5207813df3d5b83b9508125e0e9e12`. This account owns the `dubflow` backend Worker and its persisted production data in D1/R2 together with Workers AI, Analytics Engine, Workflows, and rate-limit resources.

The public gateway owns no DubFlow database or media state. It forwards `yupvox.qs3d.site` to the exact backend `workers.dev` origin configured as `BACKEND_ORIGIN`.

`main` remains the repository source of truth. GitHub Actions is CI only. Cloudflare Workers Builds remains the backend deployment lane for `trinhtanphat6666`; gateway deployment uses `wrangler.gateway.jsonc` in the zone-owning `trinhtanphat2403` account. The historical manual-only GitHub production deployment lane remains removed. See `docs/DEPLOYMENT-POLICY.md` and `docs/CLOUDFLARE-CROSS-ACCOUNT-WORKERS-ONLY.md`.

## Containers disabled

Cloudflare **Containers are disabled in production**. The production backend config does not declare Container resources, Container-backed Durable Objects, or Container exports. `Containers Edit` is not required for this topology.

The FFmpeg and Demucs adapters remain in source as optional implementation/test material, but there is no deployed `FFMPEG_CONTAINER` or `SEPARATOR_CONTAINER` binding. Media operations that require those bindings remain fail-closed. A GREEN source test does not mean a paid Container is running.

## Runtime qualification boundary

Worker-native project/state/UI/translation/observability paths can be deployed on the backend account. Media processing that requires the absent FFmpeg Container and dialogue separation that requires the absent Demucs Container remain **UNQUALIFIED** and unavailable until a different qualified media runtime is implemented.

The cross-account gateway itself does not upgrade provider/media qualification. Public and backend readiness must be checked independently during rollout.

## Phase 3B usage qualification

Phase 3B retains the durable idempotent usage ledger for ASR, translation, generated TTS audio and final render. Persisted/API units remain seconds for ASR/TTS/render and Unicode source characters for translation. `users.credit_balance` remains informational/read-only; no pricing or credit decrement is introduced by this deployment change.

## Phase 3C observability, rate-limit, and sharing qualification

Phase 3C keeps the `dubflow_events` Analytics Engine dataset and the five original isolated admission lanes: `RATE_LIMIT_PROCESS`, `RATE_LIMIT_EXPORT`, `RATE_LIMIT_TRANSLATE`, `RATE_LIMIT_VOICE`, and `RATE_LIMIT_UPLOAD`.

Sharing remains owner-managed and revocable. Invalid, missing, expired, revoked, or wrong anonymous share credentials continue to converge on `SHARE_NOT_FOUND`; raw bearer material is not persisted as public state. Cross-account routing does not move these backend responsibilities into the gateway account.

The historical manual-only GitHub production lane remains removed; source/CI qualification does not prove real provider or media execution. Production runtime status remains **UNQUALIFIED**.

## Phase 4A translation context qualification

Phase 4A translation context remains **source-qualified only**. Project style/glossary settings are revision-safe and owner scoped. The contextual model runtime is not proven by source CI, and runtime status remains **UNQUALIFIED**.

## Phase 4A project-stable diarization qualification

Phase 4A diarization keeps 300-second ASR windows with a 15-second overlap. The canonical stride is 285 seconds (`300 - 15`), preserving the fixed overlap contract. Duplicate suppression and conservative speaker reconciliation remain deterministic across rerun paths.

Production runtime remains **UNQUALIFIED** until a supported real provider/media fixture proves cross-window persisted speaker linkage and safe rerun reconciliation.

## Phase 4B safe managed voice clone qualification

Phase 4B remains **source/CI qualification only** for managed ElevenLabs IVC enrollment. Explicit consent and project ownership boundaries are unchanged. The historical manual-only GitHub production path remains removed; production runtime remains **UNQUALIFIED** until a real authorized IVC fixture passes.

## Phase 4C multi-language batch export qualification

Phase 4C remains **source/CI qualification only** for `vi`, `en`, `ja`, `ko`, and `zh`. Vietnamese remains available for backward compatibility, including the legacy `vi` dubbing path, while target-language variants remain independently persisted.

Canonical target artifact paths remain:

- `projects/{projectId}/voices/{targetLanguage}/...`
- `projects/{projectId}/subtitles/{targetLanguage}/{exportId}.srt`
- `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`

`RATE_LIMIT_BATCH_EXPORT` remains the dedicated batch admission lane. Multi-language runtime that depends on final FFmpeg rendering is **UNQUALIFIED** while Containers are disabled.

Production runtime remains **UNQUALIFIED** until a real authorized provider/media fixture proves at least two distinct target languages end-to-end through translation, TTS, final render, retrieval, and concrete export sharing.

## Phase 4D hybrid audio treatment qualification

Phase 4D remains **source/CI qualification only** for `dubbed_only`, `duck_original`, and `separated_background`. Migration `0011_phase4d_audio_separation.sql` defines the source-generation/audio-mode/stem schema.

`SEPARATION_RUNTIME_QUALIFIED` stays `false`. Because Containers are disabled and no `SEPARATOR_CONTAINER` binding is deployed, true separated-background preparation remains fail-closed and **UNQUALIFIED**. The source Demucs adapter may remain for future implementation work, but production must not claim it as live.

Cloudflare Workers Builds can deploy the account-6666 Worker without publishing a Container image. GitHub Actions remains CI-only.

## Phase 4E optional visual lip-sync qualification

Phase 4E is **source/CI qualification only** for optional visual lip-sync. Migration `0012_visual_lipsync.sql` advances the source readiness target to schema revision **12** and persists visual processing state plus bounded provider-media grant authority.

The canonical standard export remains `projects/{projectId}/exports/{targetLanguage}/{exportId}.mp4`; a successful visual result remains separate as `projects/{projectId}/exports/{targetLanguage}/{exportId}.lipsync.mp4`.

Sync Labs remains optional. `SYNC_API_KEY` means only that the provider credential is configured; it does **not** qualify runtime behavior or enable lip-sync admission by itself. `SYNC_LIPSYNC_QUALIFIED` is a separate fail-closed runtime latch and must remain unset or `false` until a real supported Sync provider/media fixture succeeds end-to-end. Source CI, mock-provider tests, Wrangler dry-run, screenshots, successful deployment, or the presence of `SYNC_API_KEY` must not set that latch automatically.

Only `SYNC_LIPSYNC_QUALIFIED=true` together with a configured Sync key may expose visual lip-sync as qualified to API admission and Workflow execution. Production runtime remains **UNQUALIFIED** until that real fixture completes end-to-end; this cross-account deployment change does not preclaim qualification.

## Deployment verification

The safe rollout order is:

1. Merge a fully green commit to `main`.
2. Deploy the backend in `trinhtanphat6666` with `wrangler.jsonc` and confirm its exact `workers.dev` origin.
3. Verify backend `/api/ready` directly.
4. Configure `BACKEND_ORIGIN` on `dubflow-gateway` and deploy `wrangler.gateway.jsonc` in `trinhtanphat2403`.
5. Verify `https://yupvox.qs3d.site/api/ready` reaches the intended backend state/schema.

No successful deploy, source CI result, screenshot, or Wrangler dry-run alone upgrades provider/media runtime from **UNQUALIFIED**.
