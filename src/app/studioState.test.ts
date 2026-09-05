import { describe, expect, it } from 'vitest';
import { mockProject } from './mockProject';
import { createInitialStudioState, studioReducer } from './studioState';
import type { StudioProject } from '../features/timeline/types';

describe('studioReducer', () => {
  it('selects a segment and moves the playhead to its start', () => {
    const state = studioReducer(createInitialStudioState(mockProject), { type: 'selectSegment', segmentId: 's2' });
    expect(state.selectedSegmentId).toBe('s2');
    expect(state.playheadMs).toBe(928000);
  });

  it('edits the translated text immutably', () => {
    const initial = createInitialStudioState(mockProject);
    const state = studioReducer(initial, { type: 'editTranslation', segmentId: 's1', text: 'Bản dịch mới' });
    expect(state.project.segments[0]?.translatedText).toBe('Bản dịch mới');
    expect(initial.project.segments[0]?.translatedText).not.toBe('Bản dịch mới');
  });

  it('assigns a valid speaker and toggles lip sync', () => {
    let state = createInitialStudioState(mockProject);
    state = studioReducer(state, { type: 'assignSpeaker', segmentId: 's1', speakerId: 'ye' });
    expect(state.project.segments[0]?.speakerId).toBe('ye');
    state = studioReducer(state, { type: 'toggleLipSync' });
    expect(state.lipSyncEnabled).toBe(false);
  });

  it('hydrates a persisted cloud project while retaining a matching selection', () => {
    let state = createInitialStudioState(mockProject);
    state = studioReducer(state, { type: 'selectSegment', segmentId: 's2' });
    const cloudProject: StudioProject = {
      ...mockProject,
      id: 'cloud-p1',
      title: 'Cloud project',
      durationMs: 5000,
      segments: [
        { ...mockProject.segments[1]!, startMs: 1200, endMs: 2200 },
        { ...mockProject.segments[2]!, startMs: 2500, endMs: 3500 },
      ],
    };
    const next = studioReducer(state, { type: 'hydrateProject', project: cloudProject });
    expect(next.project.id).toBe('cloud-p1');
    expect(next.selectedSegmentId).toBe('s2');
    expect(next.playheadMs).toBe(1200);
  });

  it('selects the first persisted segment when the previous selection disappeared', () => {
    const initial = createInitialStudioState(mockProject);
    const cloudProject: StudioProject = {
      ...mockProject,
      id: 'cloud-p2',
      durationMs: 1000,
      segments: [{ id: 'cloud-s1', speakerId: 'lin', startMs: 100, endMs: 500, sourceText: '新', translatedText: 'mới' }],
    };
    const next = studioReducer(initial, { type: 'hydrateProject', project: cloudProject });
    expect(next.selectedSegmentId).toBe('cloud-s1');
    expect(next.playheadMs).toBe(100);
  });
});
