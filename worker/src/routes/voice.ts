import { Hono } from 'hono';
import type { Env } from '../env';
import { WorkersAIVoiceProvider } from '../services/voice/workers-ai';

export function createVoiceRoutes() {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get('/capabilities', (c) => {
    const provider = new WorkersAIVoiceProvider(c.env.AI);
    return c.json(provider.capabilities());
  });
  return routes;
}
