import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { AudioSeparationRepository } from '../db/audio-separation';
import { JobRepository } from '../db/jobs';
import { ProjectRepository } from '../db/projects';
import { UsageRepository } from '../db/usage';
import { createTelemetry } from '../observability/telemetry';
import { createSeparationProvider } from '../services/separation/config';
import { runSeparationPipeline, type SeparationWorkflowParams } from './separationPipeline';

export class SeparationWorkflow extends WorkflowEntrypoint<Env, SeparationWorkflowParams> {
  async run(event: WorkflowEvent<SeparationWorkflowParams>, step: WorkflowStep) {
    const projects = new ProjectRepository(this.env.DB);
    return runSeparationPipeline(
      event.payload,
      {
        projects: {
          async getByIdForUser(projectId: string, userId: string) {
            const project = await projects.getByIdForUser(projectId, userId);
            return project ? { ...project, sourceObjectKey: project.sourceObjectKey ?? null } : null;
          },
        },
        jobs: new JobRepository(this.env.DB),
        separations: new AudioSeparationRepository(this.env.DB),
        provider: createSeparationProvider(this.env),
        usage: new UsageRepository(this.env.DB),
        telemetry: createTelemetry(this.env),
      },
      step,
    );
  }
}
