# DubFlow

DubFlow is a Cloudflare-first AI dubbing studio with a high-density workstation UI, editable bilingual script, speaker tracks, media preview and a multi-track timeline. The interface is intentionally matched closely to the supplied visual reference.

## Phase 1 included

- React + TypeScript + Vite studio UI.
- Cloudflare Worker API with Hono.
- Workers Static Assets deployment shape.
- D1 schema for users, projects, speakers, segments, jobs and usage events.
- R2 and Workers AI bindings prepared for Phase 2.
- Local MP4/WebM/MKV/MOV selection with 5 GB and 3 hour validation boundaries.
- Dual-language player subtitles.
- Editable source + Vietnamese script inspector.
- Deterministic speaker waveform tracks and selectable timeline segments.
- GitHub Actions CI for tests, typecheck and production build.

Phase 2 will add the real multipart R2 upload, FFmpeg container pipeline, Workers AI ASR/TTS, Workers AI + official Google Cloud Translation routing, persisted editable segments and export.

## Local setup

```bash
npm install
npm run verify
npm run dev
```

## GitHub Actions CI

`.github/workflows/ci.yml` runs on pull requests, pushes to the active development branches and `main`, and manual `workflow_dispatch` runs.

The CI gate runs:

```bash
npm install --no-audit --no-fund
npm run test
npm run typecheck
npm run build
```

CI is verification-only. Cloudflare deployment is not triggered automatically and no Cloudflare secrets are required by the CI workflow.

## Cloudflare setup

Authenticate and create the backing services:

```bash
npx wrangler login
npx wrangler d1 create dubflow-db
npx wrangler r2 bucket create dubflow-media
```

Copy the returned D1 database ID into `wrangler.jsonc`, then apply the migration:

```bash
npx wrangler d1 migrations apply dubflow-db --remote
```

When Google Cloud Translation is enabled in Phase 2, store the official API credential as a secret; never commit it:

```bash
npx wrangler secret put GOOGLE_CLOUD_TRANSLATE_API_KEY
```

Build and deploy manually from the developer machine:

```bash
npm run verify
npx wrangler deploy
```

## Delivery rule

Pull requests should be merged only after the GitHub Actions `CI / Test, typecheck, build` gate is green. Cloudflare deployment remains an explicit separate action.

## Architecture documents

- `docs/superpowers/specs/2026-09-05-dubflow-design.md`
- `docs/superpowers/plans/2026-09-05-dubflow-phase1-foundation-ui.md`
