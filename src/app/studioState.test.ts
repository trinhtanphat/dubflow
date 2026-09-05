import { describe, expect, it } from 'vitest';
import { mockProject } from './mockProject';
import { createInitialStudioState, studioReducer } from './studioState';

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

  it('hydrates cloud data while preserving a still-valid selected segment', () => {
    let state = studioReducer(createInitialStudioState(mockProject), { type: 'selectSegment', segmentId: 's2' });
    const refreshed = {
      ...mockProject,
      title: 'Cloud refresh',
      segments: mockProject.segments.map((segment) => segment.id === 's2' ? { ...segment, translatedText: 'Đã refresh' } : segment),
    };
    state = studioReducer(state, { type: 'hydrateProject', project: refreshed });
    expect(state.project.title).toBe('Cloud refresh');
    expect(state.selectedSegmentId).toBe('s2');
    expect(state.project.segments.find((segment) => segment.id === 's2')?.translatedText).toBe('Đã refresh');
  });

  it('selects the first segment when a cloud refresh removes the previous selection', () => {
    let state = studioReducer(createInitialStudioState(mockProject), { type: 'selectSegment', segmentId: 's3' });
    state = studioReducer(state, { type: 'hydrateProject', project: { ...mockProject, segments: [mockProject.segments[0]] } });
    expect(state.selectedSegmentId).toBe('s1');
    expect(state.playheadMs).toBe(mockProject.segments[0].startMs);
  });
});
