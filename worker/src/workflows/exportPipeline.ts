import type { VisualMode } from '../domain/visual-mode';
import { runExportPipeline as runLegacyExportPipeline } from './legacyExportPipeline';
import type {
  ExportPipelineDeps as LegacyExportPipelineDeps,
  ExportWorkflowParams as LegacyExportWorkflowParams,
  ExportWorkflowStepLike,
} from './legacyExportPipeline';
import {
  runZeroContainerExportPipeline,
  type ZeroContainerExportDeps,
  type ZeroContainerExportParams,
} from './zeroContainerExportPipeline';

export type {
  ExportClip,
  ExportWorkflowStepLike,
} from './legacyExportPipeline';

export type ExportWorkflowParams = LegacyExportWorkflowParams & {
  visualMode?: VisualMode;
};

export type ExportPipelineDeps = Omit<LegacyExportPipelineDeps, 'media'> & {
  media?: LegacyExportPipelineDeps['media'];
  soundtrack?: ZeroContainerExportDeps['soundtrack'];
  publisher?: ZeroContainerExportDeps['publisher'];
  providerMediaGrants?: ZeroContainerExportDeps['providerMediaGrants'];
  lipSync?: ZeroContainerExportDeps['lipSync'];
  makeProviderMediaToken?: ZeroContainerExportDeps['makeProviderMediaToken'];
  providerMediaOrigin?: ZeroContainerExportDeps['providerMediaOrigin'];
  fetchImpl?: ZeroContainerExportDeps['fetchImpl'];
};

type RunExportParams = Parameters<typeof runLegacyExportPipeline>[0] & {
  visualMode?: VisualMode;
};

type CandidateParams = RunExportParams & {
  exportId?: unknown;
  targetLanguage?: unknown;
  output?: unknown;
  audioMode?: unknown;
  visualMode?: unknown;
};

function candidate(input: RunExportParams): CandidateParams {
  return input as CandidateParams;
}

function hasModernExportFields(input: RunExportParams): boolean {
  const value = candidate(input);
  return value.exportId !== undefined
    || value.targetLanguage !== undefined
    || value.output !== undefined
    || value.audioMode !== undefined
    || value.visualMode !== undefined;
}

function shouldUseZeroContainer(input: RunExportParams, deps: ExportPipelineDeps): boolean {
  if (!deps.soundtrack || !deps.publisher) return false;
  if (!hasModernExportFields(input)) return true;
  const value = candidate(input);
  return value.output === 'dubbed' && value.audioMode === 'dubbed_only';
}

export async function runExportPipeline(
  input: RunExportParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): ReturnType<typeof runLegacyExportPipeline> {
  if (shouldUseZeroContainer(input, deps)) {
    return runZeroContainerExportPipeline(
      input as ZeroContainerExportParams,
      deps as unknown as ZeroContainerExportDeps,
      step,
    );
  }

  const value = candidate(input);
  if (!deps.media && value.output !== 'subtitles') {
    throw new Error('Media processor is unavailable.');
  }
  return runLegacyExportPipeline(
    input,
    deps as LegacyExportPipelineDeps,
    step,
  );
}
