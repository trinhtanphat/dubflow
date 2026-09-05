import { Hono } from 'hono';
import type { Env } from './env';
import { projectsRoute } from './routes/projects';

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, service: 'dubflow', phase: 'foundation' }));
app.route('/api/projects', projectsRoute);

app.onError((error, c) => {
  console.error('Unhandled API error', error);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } }, 500);
});

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
