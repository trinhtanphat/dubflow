import { useReducer } from 'react';
import { mockProject } from './mockProject';
import type { StudioProject } from '../features/timeline/types';

type State = {
  project: StudioProject;
  selectedSegmentId: string;
  playheadMs: number;
  lipSync: boolean;
  isPlaying: boolean;
};

type Action =
  | { type: 'select'; id: string }
  | { type: 'playhead'; value: number }
  | { type: 'toggle-play' }
  | { type: 'toggle-lip-sync' }
  | { type: 'edit-source'; id: string; value: string }
  | { type: 'edit-translation'; id: string; value: string };

const initialState: State = {
  project: mockProject,
  selectedSegmentId: 's2',
  playheadMs: 15 * 60 * 1000 + 23 * 1000,
  lipSync: true,
  isPlaying: false,
};

function reducer(state: State, action: Action): State {
  if (action.type === 'select') {
    const segment = state.project.segments.find((item) => item.id === action.id);
    return { ...state, selectedSegmentId: action.id, playheadMs: segment?.startMs ?? state.playheadMs };
  }
  if (action.type === 'playhead') return { ...state, playheadMs: action.value };
  if (action.type === 'toggle-play') return { ...state, isPlaying: !state.isPlaying };
  if (action.type === 'toggle-lip-sync') return { ...state, lipSync: !state.lipSync };
  if (action.type === 'edit-source' || action.type === 'edit-translation') {
    return {
      ...state,
      project: {
        ...state.project,
        segments: state.project.segments.map((segment) => {
          if (segment.id !== action.id) return segment;
          return action.type === 'edit-source'
            ? { ...segment, sourceText: action.value }
            : { ...segment, translatedText: action.value };
        }),
      },
    };
  }
  return state;
}

export function useStudioState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const selectedSegment = state.project.segments.find((segment) => segment.id === state.selectedSegmentId) ?? state.project.segments[0];
  return { state, selectedSegment, dispatch };
}
