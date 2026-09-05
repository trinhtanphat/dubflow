import { useMemo, useReducer } from 'react';
import { mockProject } from './mockProject';
import { createInitialStudioState, studioReducer } from './studioState';

export function useStudioState() {
  const [state, dispatch] = useReducer(studioReducer, mockProject, createInitialStudioState);
  const selectedSegment = useMemo(() => state.project.segments.find((segment) => segment.id === state.selectedSegmentId) ?? state.project.segments[0], [state.project.segments, state.selectedSegmentId]);
  const selectedSpeaker = useMemo(() => state.project.speakers.find((speaker) => speaker.id === selectedSegment?.speakerId) ?? state.project.speakers[0], [state.project.speakers, selectedSegment]);
  return { state, dispatch, selectedSegment, selectedSpeaker };
}
