import { Hono } from 'hono';
import { requestTelemetryMiddleware, type WorkerHonoEnv } from './observability/requestTelemetry';
import { healthPayload } from './routes/health';
import { checkReadiness } from './routes/readiness';
import { createProjectsRoutes } from './routes/projects';
import { createUploadRoutes } from './routes/uploads';
import { createVoiceRoutes } from './routes/voice';
import { createVoiceCloneRoutes } from './routes/voice-clones';
import { createClientVoiceRoutes } from './routes/client-voice';
import { createProcessRoutes } from './routes/process';
import { createExportRoutes } from './routes/export';
import { createVisualExportMediaRoutes } from './routes/visual-export-media';
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
import { createMediaSourceRoutes } from './routes/media-source';
import { createProviderMediaRoutes } from './routes/provider-media';
import { isR2Mp4RemuxRuntimeReady } from './services/media/mp4-remux';

const app = new Hono<WorkerHonoEnv>();
const exportRoutes = createExportRoutes();
const languageRoutes = createLanguageRoutes();
const translationVariantRoutes = createTranslationVariantRoutes();

app.use('/api/*', requestTelemetryMiddleware());
app.get('/api/health', (c) => c.json(healthPayload()));
app.get('/api/ready', async (c) => {
  const remuxReady = await isR2Mp4RemuxRuntimeReady();
  const readiness = await checkReadiness(c.env.DB, c.env.DEEPGRAM_API_KEY, {
    r2: c.env.MEDIA,
    publicOrigin: c.env.PUBLIC_ORIGIN,
    sourceSigningSecret: c.env.MEDIA_SOURCE_SIGNING_SECRET,
    remuxReady,
  }, c.env.PAID_DEEPGRAM_ASR_ENABLED, c.env.PAID_WORKERS_AI_ENABLED);
  return readiness.ready ? c.json(readiness, 200) : c.json(readiness, 503);
});
app.route('/api/media-source', createMediaSourceRoutes());
app.route('/api/projects', createProjectsRoutes());
app.route('/api/projects', createUploadRoutes());
app.route('/api/projects', createProcessRoutes());
app.route('/api/projects', createVisualExportMediaRoutes());
app.route('/api/projects', exportRoutes);
app.route('/api/projects', createProjectShareRoutes());
app.route('/api/projects', createSegmentRoutes());
app.route('/api/projects', createSpeakerRoutes());
app.route('/api/projects', createVoiceCloneRoutes());
app.route('/api/projects', createClientVoiceRoutes());
app.route('/api/projects', languageRoutes);
app.route('/api/projects', translationVariantRoutes);
app.route('/api/projects', createTranslationRoutes());
app.route('/api/projects', createTranslationContextRoutes());
app.route('/api/projects', createJobRoutes());
app.route('/api/projects', createMediaRoutes());
app.route('/api/voice', createVoiceRoutes());
app.route('/api', createUsageRoutes());
app.route('/api', createPublicShareRoutes());
app.route('/api', createProviderMediaRoutes());
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
