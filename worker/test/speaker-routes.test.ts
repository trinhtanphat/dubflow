import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { Speaker, SpeakerPatch, SpeakerStore } from '../src/db/speakers';
import { createSpeakerRoutes } from '../src/routes/speakers';

const speaker: Speaker = {
  id: 'speaker-1',
  projectId: 'project-1',
  label: 'SPEAKER_00',
  displayName: 'Nhân vật 1',
  voiceProvider: null,
  voiceId: null,
  avatarObjectKey: null,
};

class MemorySpeakerStore implements SpeakerStore {
  calls: Array<{ method: string; args: unknown[] }> = [];

  async list(projectId: string, userId: string) {
    this.calls.push({ method: 'list', args: [projectId, userId] });
    return projectId === 'project-1' && userId === 'dev-user' ? [speaker] : [];
  }

  async update(projectId: string, speakerId: string, userId: string, patch: SpeakerPatch) {
    this.calls.push({ method: 'update', args: [projectId, speakerId, userId, patch] });
    if (projectId !== 'project-1' || speakerId !== 'speaker-1' || userId !== 'dev-user') return null;
    return {
      ...speaker,
      displayName: patch.displayName ?? speaker.displayName,
      voiceProvider: patch.voiceId === undefined ? speaker.voiceProvider : patch.voiceId ? 'elevenlabs' : null,
      voiceId: patch.voiceId === undefined ? speaker.voiceId : patch.voiceId,
    };
  }
}

function makeApp(store: SpeakerStore) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/projects', createSpeakerRoutes(() => store));
  return app;
}

describe('speaker voice assignment routes', () => {
  it('lists persisted speaker metadata for the current user project', async () => {
    const store = new MemorySpeakerStore();
    const response = await makeApp(store).request('/api/projects/project-1/speakers');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([speaker]);
    expect(store.calls).toContainEqual({ method: 'list', args: ['project-1', 'dev-user'] });
  });

  it('persists ElevenLabs voice assignment and display name', async () => {
    const store = new MemorySpeakerStore();
    const response = await makeApp(store).request('/api/projects/project-1/speakers/speaker-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nữ chính', voiceId: 'voice-heroine' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      displayName: 'Nữ chính',
      voiceProvider: 'elevenlabs',
      voiceId: 'voice-heroine',
    });
    expect(store.calls).toContainEqual({
      method: 'update',
      args: ['project-1', 'speaker-1', 'dev-user', { displayName: 'Nữ chính', voiceId: 'voice-heroine' }],
    });
  });

  it('rejects blank display names and whitespace-only voice ids', async () => {
    const store = new MemorySpeakerStore();
    const response = await makeApp(store).request('/api/projects/project-1/speakers/speaker-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '   ', voiceId: '   ' }),
    });
    expect(response.status).toBe(400);
    expect(store.calls.some((call) => call.method === 'update')).toBe(false);
  });
});
