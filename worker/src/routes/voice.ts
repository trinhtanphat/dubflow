import { Hono } from 'hono';
import type { Env } from '../env';
import { ElevenLabsVoiceProvider } from '../services/voice/elevenlabs';
import { VoiceProviderError } from '../services/voice/types';
import { WorkersAIVoiceProvider } from '../services/voice/workers-ai';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function hasElevenLabs(env: Env) {
  return Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_DEFAULT_VOICE_ID?.trim());
}

export function createVoiceRoutes(fetcher: FetchLike = fetch) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get('/capabilities', (c) => {
    if (hasElevenLabs(c.env)) {
      const provider = new ElevenLabsVoiceProvider(
        c.env.ELEVENLABS_API_KEY ?? '',
        { defaultVoiceId: c.env.ELEVENLABS_DEFAULT_VOICE_ID },
        fetcher,
      );
      return c.json(provider.capabilities());
    }
    const provider = new WorkersAIVoiceProvider(c.env.AI);
    return c.json(provider.capabilities());
  });

  routes.post('/preview', async (c) => {
    let payload: { text?: unknown; language?: unknown; voice?: unknown };
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ code: 'INVALID_JSON', message: 'Voice preview body must be valid JSON.' }, 400);
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const language = typeof payload.language === 'string' ? payload.language : '';
    const voice = typeof payload.voice === 'string' ? payload.voice.trim() : undefined;
    if (!text) {
      return c.json({ code: 'VOICE_TEXT_REQUIRED', message: 'Voice preview text is required.' }, 400);
    }
    if (text.length > 2000) {
      return c.json({ code: 'VOICE_TEXT_TOO_LONG', message: 'Voice preview text must not exceed 2000 characters.' }, 400);
    }
    if (language !== 'vi') {
      return c.json({ code: 'VOICE_LANGUAGE_UNVERIFIED', message: 'Vietnamese is the currently qualified preview language.' }, 400);
    }
    if (!hasElevenLabs(c.env)) {
      return c.json({ code: 'VOICE_PROVIDER_UNCONFIGURED', message: 'ElevenLabs voice preview is not configured.' }, 503);
    }

    const provider = new ElevenLabsVoiceProvider(
      c.env.ELEVENLABS_API_KEY ?? '',
      { defaultVoiceId: c.env.ELEVENLABS_DEFAULT_VOICE_ID },
      fetcher,
    );

    try {
      const audio = await provider.generate({ text, language, ...(voice ? { voice } : {}) });
      const headers = new Headers();
      headers.set('content-type', audio.headers.get('content-type') ?? 'audio/mpeg');
      headers.set('cache-control', 'no-store');
      return new Response(audio.body, { status: 200, headers });
    } catch (error) {
      if (error instanceof VoiceProviderError) {
        const status = error.code === 'VOICE_PROVIDER_UNCONFIGURED' ? 503 : 502;
        return c.json({ code: error.code, message: error.message }, status);
      }
      return c.json({ code: 'VOICE_PROVIDER_FAILED', message: 'Voice preview failed.' }, 502);
    }
  });

  return routes;
}
