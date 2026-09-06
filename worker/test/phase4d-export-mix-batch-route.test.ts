import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { separationObjectPrefix } from '../src/db/audio-separation';
import { createExportRoutes } from '../src/routes/export';

const analytics = { writeDataPoint() {} };
const allowExport = { async limit() { return { success: true }; } };

describe('Phase 4D batch export mix contract', () => {
  it('reuses one current separation for every preserve-background target in the batch', async () => {
    const exportMixes: string[] = [];
    const workflowInputs: any[] = [];
    let separationReads = 0;
    let exportNumber = 0;
    let jobNumber = 0;
    const backgroundObjectKey = `${separationObjectPrefix('project-1', 3, 'demucs-container', 'sha256:8726e21a')}background.wav`;

    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createExportRoutes({
      makeProjects: () => ({
        async getByIdForUser() {
          return {
            id: 'project-1', userId: 'dev-user', status: 'needs_review', sourceRevision: 3,
            sourceObjectKey: 'projects/project-1/source/movie.mp4',
          };
        },
        async setStatus() {},
      }) as never,
      makeLanguages: () => ({
        async getConfig() {
          return { revision: 1, languages: [{ targetLanguage: 'vi' }, { targetLanguage: 'ja' }] };
        },
      }) as never,
      makeSegments: () => ({ async list() { return [{ id: 'segment-1' }]; } }) as never,
      makeVariants: () => ({
        async list(_projectId: string, _userId: string, targetLanguage: string) {
          return [{ segmentId: 'segment-1', translationStatus: 'completed', translatedText: `${targetLanguage}:hello` }];
        },
      }) as never,
      makeSeparations: () => ({
        async getCurrent() {
          separationReads += 1;
          return {
            id: 'separation-1', projectId: 'project-1', sourceRevision: 3,
            sourceObjectKey: 'projects/project-1/source/movie.mp4', sourceSizeBytes: 123,
            provider: 'demucs-container', modelId: 'htdemucs', modelDigest: 'sha256:8726e21a',
            status: 'completed', backgroundObjectKey,
            dialogueObjectKey: `${separationObjectPrefix('project-1', 3, 'demucs-container', 'sha256:8726e21a')}dialogue.wav`,
            jobId: 'separation-job', errorCode: null, errorMessage: null,
            createdAt: '', updatedAt: '', completedAt: '',
          };
        },
      }) as never,
      getSeparationCapabilities: () => ({
        configured: true, qualified: true, provider: 'demucs-container', modelId: 'htdemucs', modelDigest: 'sha256:8726e21a',
      }),
      getVoiceCapabilities: () => ({ configured: true, languages: ['vi', 'ja'] }) as never,
      makeExports: () => ({
        async create(
          _projectId: string,
          _userId: string,
          _targetLanguage: string,
          _output: string,
          _batchId: string | null,
          mixMode?: string,
        ) {
          exportMixes.push(mixMode ?? 'missing');
          exportNumber += 1;
          return { id: `export-${exportNumber}` };
        },
        async latest() { return null; },
        async latestCompleted() { return null; },
        async fail() {},
      }) as never,
      makeJobs: () => ({
        async create() { jobNumber += 1; return { id: `job-${jobNumber}` }; },
        async fail() {},
      }) as never,
      makeBatchId: () => 'batch-1',
    }));

    const env = {
      ANALYTICS: analytics,
      RATE_LIMIT_EXPORT: allowExport,
      EXPORT_WORKFLOW: {
        async create(input: any) { workflowInputs.push(input); return { id: `workflow-${workflowInputs.length}` }; },
      },
    } as unknown as Env;

    const response = await app.request('/api/projects/project-1/exports/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetLanguages: ['vi', 'ja'], output: 'dubbed', mixMode: 'preserve_background' }),
    }, env);

    expect(response.status).toBe(202);
    expect(separationReads).toBe(1);
    expect(exportMixes).toEqual(['preserve_background', 'preserve_background']);
    expect(workflowInputs.map((input) => input.params.mixMode)).toEqual(['preserve_background', 'preserve_background']);
  });
});
