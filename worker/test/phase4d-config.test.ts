import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('Phase 4D Cloudflare wiring and readiness source contract', () => {
  it('declares an isolated separation limiter, workflow, standard-4 container and durable-object binding', () => {
    const wrangler = read('wrangler.jsonc');
    expect(wrangler).toMatch(/"RATE_LIMIT_SEPARATION"/);
    expect(wrangler).toMatch(/"namespace_id"\s*:\s*"31008"/);
    expect(wrangler).toMatch(/"limit"\s*:\s*2[\s\S]*?"period"\s*:\s*60/);
    expect(wrangler).toMatch(/"SEPARATION_WORKFLOW"[\s\S]*?"SeparationWorkflow"/);
    expect(wrangler).toMatch(/"SeparatorContainer"[\s\S]*?"\.\/containers\/separator\/Dockerfile"[\s\S]*?"standard-4"/);
    expect(wrangler).toMatch(/"SEPARATOR_CONTAINER"[\s\S]*?"SeparatorContainer"/);
  });

  it('exports and mounts the separator runtime without replacing the existing FFmpeg runtime', () => {
    const index = read('worker/src/index.ts');
    const app = read('worker/src/app.ts');
    expect(index).toMatch(/SeparatorContainer/);
    expect(index).toMatch(/SeparationWorkflow/);
    expect(index).toMatch(/FfmpegContainer/);
    expect(app).toMatch(/createSeparationRoutes/);
    expect(app).toMatch(/app\.route\('\/api\/projects',[\s\S]*createSeparationRoutes/);
  });

  it('types the dedicated bindings and keeps separation isolated from generic export rate limiting', () => {
    const env = read('worker/src/env.ts');
    const limiter = read('worker/src/security/rate-limit.ts');
    expect(env).toMatch(/RATE_LIMIT_SEPARATION/);
    expect(env).toMatch(/SEPARATOR_CONTAINER/);
    expect(env).toMatch(/SEPARATION_WORKFLOW/);
    expect(limiter).toMatch(/'separation'/);
    expect(limiter).toMatch(/separation:\s*env\.RATE_LIMIT_SEPARATION/);
  });

  it('requires Phase 4D schema in readiness and reports separator capability without claiming qualification', () => {
    const readiness = read('worker/src/routes/readiness.ts');
    expect(readiness).toMatch(/project_audio_separations/);
    expect(readiness).toMatch(/source_revision/);
    expect(readiness).toMatch(/mix_mode/);
    expect(readiness).toMatch(/separation/i);
    expect(readiness).toMatch(/qualified/);
  });
});
