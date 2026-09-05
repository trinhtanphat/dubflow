# DubFlow

DubFlow is a Cloudflare-first AI dubbing studio. Phase 1 provides the full workstation UI and project foundation; later phases add R2 multipart upload, Workers AI ASR/TTS, Workers AI contextual translation, official Google Cloud Translation, FFmpeg processing, Cloudflare Workflows, credits and production auth.

## Current Phase 1

- React + TypeScript dubbing workstation UI
- dual-language script editor and deterministic multi-track timeline
- 5 GB / 3 hour media validation primitives
- source languages: auto / Chinese / English / Japanese / Korean
- Vietnamese target language
- Hono Worker health + project API foundation
- D1 schema for users, projects, speakers, segments, jobs and usage
- R2 / Workers AI bindings reserved in Wrangler config
- no GitHub Actions; deployment is Wrangler-only
- AI generation/export buttons remain explicitly marked as Phase 2 until providers are connected

## Local setup

```bash
npm install
npm run verify:no-actions
npm run test
npm run build
```

No `.github/workflows` directory is allowed in this repository.

## Cloudflare setup — no GitHub Actions

Authenticate Wrangler:

```bash
npx wrangler login
```

Create D1 and R2 resources once:

```bash
npx wrangler d1 create dubflow-db
npx wrangler r2 bucket create dubflow-media
```

Copy the D1 UUID returned by the first command into `wrangler.jsonc` as `database_id`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Apply the schema:

```bash
npx wrangler d1 migrations apply dubflow-db --remote
```

Run the local verification gate and deploy:

```bash
npm run verify
npx wrangler deploy
```

The React `dist/` directory is served by Workers Static Assets and `/api/*` runs through the Worker first.

## Phase 2 provider secrets

Google translation will use the **official Google Cloud Translation API**, never scraping the consumer Google Translate website. Do not commit credentials. When Phase 2 lands, configure its credential through Wrangler secrets, for example:

```bash
npx wrangler secret put GOOGLE_CLOUD_TRANSLATE_API_KEY
```

Workers AI uses the Cloudflare `AI` binding and does not need an API key committed to source.

## Media architecture

Large media must not be proxied as one buffered Worker request. Phase 2 will create authorized R2 multipart upload sessions for files up to the initial product target of 5 GB / 3 hours, then hand processing to durable cloud jobs.

## Roadmap

1. **Phase 1 — Foundation + UI:** current branch.
2. **Phase 2 — Working dubbing MVP:** R2 multipart upload, FFmpeg media service, ASR, Workers AI + Google translation router, TTS, timing fit and MP4/SRT export.
3. **Phase 3 — SaaS hardening:** Workflows, SSE progress, credits, retry/cancel, auth boundary, rate limits and observability.
4. **Phase 4 — Advanced dubbing:** stronger diarization, consent-aware optional voice-cloning provider, dialogue separation and optional visual lip-sync.
