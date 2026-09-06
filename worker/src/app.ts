import { Hono } from 'hono';
import { requestTelemetryMiddleware, type WorkerHonoEnv } from './observability/requestTelemetry';
import { healthPayload } from './routes/health';
import { checkReadiness } from './routes/readiness';
import { createProjectsRoutes } from './routes/projects';
import { createUploadRoutes } from './routes/uploads';
import { createVoiceRoutes } from './routes/voice';
import { createVoiceCloneRoutes } from './routes/voice-clones';
import { createProcessRoutes } from './routes/process';
import { createExportRoutes } from './routes/export';
import { createSegmentRoutes } from './routes/segments';
import { createSpeakerRoutes } from './routes/speakers';
import { createTranslationRoutes } from './routes/translation';
import { createTranslationContextRoutes } from './routes/translation-context';
import { createLanguageRoutes } from './routes/languages';
import { createTranslationVariantRoutes } from './routes/translation-variants';
import { createJobRoutes } from './routes/jobs';
import { createMediaRoutes } from './routes/media';
import { createUsageRoutes } from './routes/usage';
import { createProjectShareRoutes, createPublicShareRoutes } from './routes/shares';
import { createStreamSourceRoutes } from './routes/stream-source';

const app = new Hono<WorkerHonoEnv>();
const exportRoutes = createExportRoutes();
const languageRoutes = createLanguageRoutes();
const translationVariantRoutes = createTranslationVariantRoutes();

app.use('/api/*', requestTelemetryMiddleware());
app.get('/api/health', (c) => c.json(healthPayload()));
app.get('/api/ready', async (c) => {
  const readiness = await checkReadiness(c.env.DB, c.env.DEEPGRAM_API_KEY, {
    stream: c.env.STREAM,
    accountId: c.env.CLOUDFLARE_ACCOUNT_ID,
    sourceSigningSecret: c.env.STREAM_SOURCE_SIGNING_SECRET,
    streamApiToken: c.env.CLOUDFLARE_STREAM_API_TOKEN,
  });
  return readiness.ready ? c.json(readiness, 200) : c.json(readiness, 503);
});
app.route('/api/stream-source', createStreamSourceRoutes());
app.route('/api/projects', createProjectsRoutes());
app.route('/api/projects', createUploadRoutes());
app.route('/api/projects', createProcessRoutes());
app.route('/api/projects', exportRoutes);
app.route('/api/projects', createProjectShareRoutes());
app.route('/api/projects', createSegmentRoutes());
app.route('/api/projects', createSpeakerRoutes());
app.route('/api/projects', createVoiceCloneRoutes());
app.route('/api/projects', languageRoutes);
app.route('/api/projects', translationVariantRoutes);
app.route('/api/projects', createTranslationRoutes());
app.route('/api/projects', createTranslationContextRoutes());
app.route('/api/projects', createJobRoutes());
app.route('/api/projects', createMediaRoutes());
app.route('/api/voice', createVoiceRoutes());
app.route('/api', createUsageRoutes());
app.route('/api', createPublicShareRoutes());
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
