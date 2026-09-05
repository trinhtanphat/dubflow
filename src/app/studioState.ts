import { clampPixelsPerSecond } from '../features/timeline/math';
import type { StudioProject } from '../features/timeline/types';

export type PlaybackRate = 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2;

export type StudioState = {
  project: StudioProject;
  selectedSegmentId: string;
  playheadMs: number;
  lipSyncEnabled: boolean;
  playback: {
    playing: boolean;
    rate: PlaybackRate;
    volume: number;
    muted: boolean;
  };
  timelineView: {
    pixelsPerSecond: number;
    scrollLeft: number;
    viewportWidth: number;
  };
};

export type StudioAction =
  | { type: 'selectSegment'; segmentId: string }
  | { type: 'setPlayhead'; playheadMs: number }
  | { type: 'editSource'; segmentId: string; text: string }
  | { type: 'editTranslation'; segmentId: string; text: string }
  | { type: 'assignSpeaker'; segmentId: string; speakerId: string }
  | { type: 'toggleLipSync' }
  | { type: 'setPlaying'; playing: boolean }
  | { type: 'setPlaybackRate'; rate: PlaybackRate }
  | { type: 'setVolume'; volume: number }
  | { type: 'toggleMuted' }
  | { type: 'setTimelineZoom'; pixelsPerSecond: number }
  | { type: 'setTimelineScroll'; scrollLeft: number }
  | { type: 'setTimelineViewport'; viewportWidth: number };

export function createInitialStudioState(project: StudioProject): StudioState {
  const firstSegment = project.segments[0];
  return {
    project,
    selectedSegmentId: firstSegment?.id ?? '',
    playheadMs: firstSegment?.startMs ?? 0,
    lipSyncEnabled: true,
    playback: { playing: false, rate: 1, volume: 1, muted: false },
    timelineView: { pixelsPerSecond: 1, scrollLeft: 0, viewportWidth: 0 },
  };
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
    case 'toggleLipSync':
      return { ...state, lipSyncEnabled: !state.lipSyncEnabled };
    case 'setPlaying':
      return { ...state, playback: { ...state.playback, playing: action.playing } };
    case 'setPlaybackRate':
      return { ...state, playback: { ...state.playback, rate: action.rate } };
    case 'setVolume':
      return { ...state, playback: { ...state.playback, volume: Math.max(0, Math.min(1, action.volume)) } };
    case 'toggleMuted':
      return { ...state, playback: { ...state.playback, muted: !state.playback.muted } };
    case 'setTimelineZoom':
      return { ...state, timelineView: { ...state.timelineView, pixelsPerSecond: clampPixelsPerSecond(action.pixelsPerSecond) } };
    case 'setTimelineScroll':
      return {
        ...state,
        timelineView: {
          ...state.timelineView,
          scrollLeft: Number.isFinite(action.scrollLeft) ? Math.max(0, action.scrollLeft) : 0,
        },
      };
    case 'setTimelineViewport':
      return {
        ...state,
        timelineView: {
          ...state.timelineView,
          viewportWidth: Number.isFinite(action.viewportWidth) ? Math.max(0, action.viewportWidth) : 0,
        },
      };
    default:
      return state;
  }
}
