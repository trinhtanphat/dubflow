import { Hono } from 'hono';
import type { Env } from './env';
import { healthPayload } from './routes/health';
import { createProjectsRoutes } from './routes/projects';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json(healthPayload()));
app.route('/api/projects', createProjectsRoutes());
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
