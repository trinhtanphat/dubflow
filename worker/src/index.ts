import { Hono } from 'hono';
import type { Env } from './env';
import { healthPayload } from './routes/health';
import { checkReadiness } from './routes/readiness';
import { createProjectsRoutes } from './routes/projects';
import { createUploadRoutes } from './routes/uploads';
import { createVoiceRoutes } from './routes/voice';
import { createProcessRoutes } from './routes/process';
import { createSegmentRoutes } from './routes/segments';
import { createTranslationRoutes } from './routes/translation';
import { createMediaRoutes } from './routes/media';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json(healthPayload()));
app.get('/api/ready', async (c) => {
  const readiness = await checkReadiness(c.env.DB);
  return readiness.ready ? c.json(readiness, 200) : c.json(readiness, 503);
});
app.route('/api/projects', createProjectsRoutes());
app.route('/api/projects', createUploadRoutes());
app.route('/api/projects', createProcessRoutes());
app.route('/api/projects', createSegmentRoutes());
app.route('/api/projects', createTranslationRoutes());
app.route('/api/projects', createMediaRoutes());
app.route('/api/voice', createVoiceRoutes());
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
