import { runExportPipeline as runLegacyExportPipeline } from './legacyExportPipeline';
import type {
  ExportPipelineDeps as LegacyExportPipelineDeps,
  ExportWorkflowStepLike,
} from './legacyExportPipeline';
import {
  runZeroContainerExportPipeline,
  type ZeroContainerExportDeps,
  type ZeroContainerExportParams,
} from './zeroContainerExportPipeline';

export type {
  ExportClip,
  ExportWorkflowParams,
  ExportWorkflowStepLike,
} from './legacyExportPipeline';

export type ExportPipelineDeps = Omit<LegacyExportPipelineDeps, 'media'> & {
  media?: LegacyExportPipelineDeps['media'];
  soundtrack?: ZeroContainerExportDeps['soundtrack'];
  publisher?: ZeroContainerExportDeps['publisher'];
};

type RunExportParams = Parameters<typeof runLegacyExportPipeline>[0];

function hasModernExportFields(input: RunExportParams): boolean {
  const candidate = input as RunExportParams & {
    exportId?: unknown;
    targetLanguage?: unknown;
    output?: unknown;
    audioMode?: unknown;
  };
  return candidate.exportId !== undefined
    || candidate.targetLanguage !== undefined
    || candidate.output !== undefined
    || candidate.audioMode !== undefined;
}

export async function runExportPipeline(
  input: RunExportParams,
  deps: ExportPipelineDeps,
  step: ExportWorkflowStepLike,
): ReturnType<typeof runLegacyExportPipeline> {
  if (deps.soundtrack && deps.publisher && !hasModernExportFields(input)) {
    return runZeroContainerExportPipeline(
      input as ZeroContainerExportParams,
      deps as unknown as ZeroContainerExportDeps,
      step,
    );
  }
  if (!deps.media) throw new Error('Media processor is unavailable.');
  return runLegacyExportPipeline(
    input,
    deps as LegacyExportPipelineDeps,
    step,
  );
}
