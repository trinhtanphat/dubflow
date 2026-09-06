import { Hono } from 'hono';
import { requestTelemetryMiddleware, type WorkerHonoEnv } from './observability/requestTelemetry';
import { healthPayload } from './routes/health';
import { checkReadiness } from './routes/readiness';
import { createProjectsRoutes } from './routes/projects';
import { createUploadRoutes } from './routes/uploads';
import { createVoiceRoutes } from './routes/voice';
import { createProcessRoutes } from './routes/process';
import { createExportRoutes } from './routes/export';
import { createSegmentRoutes } from './routes/segments';
import { createSpeakerRoutes } from './routes/speakers';
import { createTranslationRoutes } from './routes/translation';
import { createTranslationContextRoutes } from './routes/translation-context';
import { createJobRoutes } from './routes/jobs';
import { createMediaRoutes } from './routes/media';
import { createUsageRoutes } from './routes/usage';
import { createProjectShareRoutes, createPublicShareRoutes } from './routes/shares';

const app = new Hono<WorkerHonoEnv>();

app.use('/api/*', requestTelemetryMiddleware());
app.get('/api/health', (c) => c.json(healthPayload()));
app.get('/api/ready', async (c) => {
  const readiness = await checkReadiness(c.env.DB, c.env.DEEPGRAM_API_KEY);
  return readiness.ready ? c.json(readiness, 200) : c.json(readiness, 503);
});
app.route('/api/projects', createProjectsRoutes());
app.route('/api/projects', createUploadRoutes());
app.route('/api/projects', createProcessRoutes());
app.route('/api/projects', createExportRoutes());
app.route('/api/projects', createProjectShareRoutes());
app.route('/api/projects', createSegmentRoutes());
app.route('/api/projects', createSpeakerRoutes());
app.route('/api/projects', createTranslationRoutes());
app.route('/api/projects', createTranslationContextRoutes());
app.route('/api/projects', createJobRoutes());
app.route('/api/projects', createMediaRoutes());
app.route('/api/voice', createVoiceRoutes());
app.route('/api', createUsageRoutes());
app.route('/api', createPublicShareRoutes());
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
