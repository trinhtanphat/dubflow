import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import {
  runLanguageTranslationPipeline,
  type LanguageTranslationWorkflowParams,
} from './languageTranslationPipeline';

export class LanguageTranslationWorkflow extends WorkflowEntrypoint<Env, LanguageTranslationWorkflowParams> {
  async run(event: WorkflowEvent<LanguageTranslationWorkflowParams>, _step: WorkflowStep) {
    return runLanguageTranslationPipeline(event.payload);
  }
}
