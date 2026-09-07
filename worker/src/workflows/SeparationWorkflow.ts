import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { AudioStemRepository } from '../db/audio-stems';
import { JobRepository } from '../db/jobs';
import { ProjectRepository } from '../db/projects';
import { UsageRepository } from '../db/usage';
import { createDialogueSeparationProvider } from '../services/separation/config';
import { runSeparationPipeline, type SeparationWorkflowParams } from './separationPipeline';

export class SeparationWorkflow extends WorkflowEntrypoint<Env, SeparationWorkflowParams> {
  async run(event: WorkflowEvent<SeparationWorkflowParams>, step: WorkflowStep) {
    return runSeparationPipeline(
      event.payload,
      {
        projects: new ProjectRepository(this.env.DB),
        jobs: new JobRepository(this.env.DB),
        stems: new AudioStemRepository(this.env.DB),
        provider: createDialogueSeparationProvider(this.env),
        usage: new UsageRepository(this.env.DB),
      },
      step,
    );
  }
}
