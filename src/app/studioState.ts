import type { StudioProject } from '../features/timeline/types';

export type StudioState = {
  project: StudioProject;
  selectedSegmentId: string;
  playheadMs: number;
  lipSyncEnabled: boolean;
};

export type StudioAction =
  | { type: 'selectSegment'; segmentId: string }
  | { type: 'setPlayhead'; playheadMs: number }
  | { type: 'editSource'; segmentId: string; text: string }
  | { type: 'editTranslation'; segmentId: string; text: string }
  | { type: 'assignSpeaker'; segmentId: string; speakerId: string }
  | { type: 'hydrateProject'; project: StudioProject }
  | { type: 'toggleLipSync' };

export function createInitialStudioState(project: StudioProject): StudioState {
  const firstSegment = project.segments[0];
  return { project, selectedSegmentId: firstSegment?.id ?? '', playheadMs: firstSegment?.startMs ?? 0, lipSyncEnabled: true };
}

function updateSegment(state: StudioState, segmentId: string, update: (segment: StudioProject['segments'][number]) => StudioProject['segments'][number]): StudioState {
  const segments = state.project.segments.map((segment) => segment.id === segmentId ? update(segment) : segment);
  return { ...state, project: { ...state.project, segments } };
}

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'selectSegment': {
      const segment = state.project.segments.find((item) => item.id === action.segmentId);
      return segment ? { ...state, selectedSegmentId: segment.id, playheadMs: segment.startMs } : state;
    }
    case 'setPlayhead':
      return { ...state, playheadMs: Math.max(0, Math.min(state.project.durationMs, action.playheadMs)) };
    case 'editSource':
      return updateSegment(state, action.segmentId, (segment) => ({ ...segment, sourceText: action.text }));
    case 'editTranslation':
      return updateSegment(state, action.segmentId, (segment) => ({ ...segment, translatedText: action.text }));
    case 'assignSpeaker':
      if (!state.project.speakers.some((speaker) => speaker.id === action.speakerId)) return state;
      return updateSegment(state, action.segmentId, (segment) => ({ ...segment, speakerId: action.speakerId }));
    case 'hydrateProject': {
      const retained = action.project.segments.find((segment) => segment.id === state.selectedSegmentId);
      const selected = retained ?? action.project.segments[0];
      const retainedPlayhead = retained && state.playheadMs >= retained.startMs && state.playheadMs <= retained.endMs
        ? state.playheadMs
        : selected?.startMs ?? 0;
      return {
        ...state,
        project: action.project,
        selectedSegmentId: selected?.id ?? '',
        playheadMs: Math.max(0, Math.min(action.project.durationMs, retainedPlayhead)),
      };
    }
    case 'toggleLipSync':
      return { ...state, lipSyncEnabled: !state.lipSyncEnabled };
    default:
      return state;
  }
}
