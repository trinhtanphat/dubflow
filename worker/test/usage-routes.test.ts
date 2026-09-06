import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { UsageAccessError, type UsageStore, type UsageSummary } from '../src/db/usage';
import { createUsageRoutes } from '../src/routes/usage';

const summary: UsageSummary = {
  totals: {
    asrAudioSeconds: 90,
    translationCharacters: 1200,
    ttsAudioSeconds: 35.5,
    dialogueSeparationSeconds: 42,
    renderSeconds: 150,
  },
  providers: {
    'deepgram-nova-3': {
      asrAudioSeconds: 90,
      translationCharacters: 0,
      ttsAudioSeconds: 0,
      dialogueSeparationSeconds: 0,
      renderSeconds: 0,
    },
    elevenlabs: {
      asrAudioSeconds: 0,
      translationCharacters: 0,
      ttsAudioSeconds: 35.5,
      dialogueSeparationSeconds: 0,
      renderSeconds: 0,
    },
  },
};

function store(overrides: Partial<UsageStore> = {}): UsageStore {
  return {
    async record() { throw new Error('not used'); },
    async getByOperation() { return null; },
    async summarizeForUser(userId: string) {
      expect(userId).toBe('dev-user');
      return summary;
    },
    async summarizeForProject(projectId: string, userId: string) {
      expect(userId).toBe('dev-user');
      if (projectId === 'hidden') throw new UsageAccessError('PROJECT_NOT_FOUND', 'Project not found.');
      return summary;
    },
    async getCreditBalance(userId: string) {
      expect(userId).toBe('dev-user');
      return 50000;
    },
    ...overrides,
  };
}

function appFor(usage: UsageStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api', createUsageRoutes(() => usage));
  return app;
}

const env = {} as Env;

describe('authorized usage summary routes', () => {
  it('returns the current user summary with informational credit balance', async () => {
    const response = await appFor(store()).request('/api/usage', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      creditBalance: 50000,
      ...summary,
    });
  });

  it('returns an owned project summary without account credit balance', async () => {
    const response = await appFor(store()).request('/api/projects/p1/usage', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
  });

  it('hides cross-user or missing project usage behind a 404', async () => {
    const response = await appFor(store()).request('/api/projects/hidden/usage', {}, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: true, code: 'PROJECT_NOT_FOUND', message: 'Project not found.' });
  });

  it('redacts internal usage failures', async () => {
    const response = await appFor(store({
      async summarizeForUser() { throw new Error('SELECT secret FROM internal_table'); },
    })).request('/api/usage', {}, env);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: boolean; code: string; message: string };
    expect(body).toEqual({ error: true, code: 'USAGE_SUMMARY_FAILED', message: 'Unable to load usage summary.' });
    expect(JSON.stringify(body)).not.toMatch(/SELECT|internal_table/);
  });
});
