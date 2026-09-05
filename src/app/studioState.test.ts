import { describe, expect, it } from 'vitest';
import { MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND } from '../features/timeline/math';
import type { StudioProject } from '../features/timeline/types';
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

  it('keeps playback controls transient and clamps volume', () => {
    const initial = createInitialStudioState(mockProject);
    expect(initial.playback).toEqual({ playing: false, rate: 1, volume: 1, muted: false });
    const playing = studioReducer(initial, { type: 'setPlaying', playing: true });
    expect(playing.playback.playing).toBe(true);
    expect(playing.project).toBe(initial.project);
    expect(studioReducer(initial, { type: 'setPlaybackRate', rate: 1.5 }).playback.rate).toBe(1.5);
    expect(studioReducer(initial, { type: 'setVolume', volume: 2 }).playback.volume).toBe(1);
    expect(studioReducer(initial, { type: 'setVolume', volume: -1 }).playback.volume).toBe(0);
    expect(studioReducer(initial, { type: 'toggleMuted' }).playback.muted).toBe(true);
  });

  it('keeps timeline viewport state transient and bounded', () => {
    const initial = createInitialStudioState(mockProject);
    expect(initial.timelineView).toEqual({ pixelsPerSecond: 1, scrollLeft: 0, viewportWidth: 0 });
    expect(studioReducer(initial, { type: 'setTimelineZoom', pixelsPerSecond: 0 }).timelineView.pixelsPerSecond).toBe(MIN_PIXELS_PER_SECOND);
    expect(studioReducer(initial, { type: 'setTimelineZoom', pixelsPerSecond: 1000 }).timelineView.pixelsPerSecond).toBe(MAX_PIXELS_PER_SECOND);
    expect(studioReducer(initial, { type: 'setTimelineScroll', scrollLeft: -50 }).timelineView.scrollLeft).toBe(0);
    const resized = studioReducer(initial, { type: 'setTimelineViewport', viewportWidth: -100 });
    expect(resized.timelineView.viewportWidth).toBe(0);
    expect(resized.project).toBe(initial.project);
  });

  it('keeps drag preview transient and commits timing once into history', () => {
    const initial = createInitialStudioState(mockProject);
    const original = initial.project.segments[0]!;
    const after = { ...original, startMs: original.startMs + 200, endMs: original.endMs + 200 };

    const preview = studioReducer(initial, {
      type: 'previewSegmentTiming',
      segmentId: original.id,
      startMs: after.startMs,
      endMs: after.endMs,
    });
    expect(preview.segmentPreview).toEqual({ segmentId: original.id, startMs: after.startMs, endMs: after.endMs });
    expect(preview.project).toBe(initial.project);
    expect(preview.history.past).toHaveLength(0);

    const committed = studioReducer(preview, { type: 'commitTimingMutation', before: original, after });
    expect(committed.project.segments[0]).toEqual(after);
    expect(committed.segmentPreview).toBeNull();
    expect(committed.history.past).toHaveLength(1);
    expect(committed.history.future).toHaveLength(0);
  });

  it('undoes and redoes a split locally while transient actions stay outside history', () => {
    const initial = createInitialStudioState(mockProject);
    const original = initial.project.segments[0]!;
    const midpoint = original.startMs + Math.floor((original.endMs - original.startMs) / 2);
    const leftAfter = { ...original, endMs: midpoint, sourceText: 'left', translatedText: 'trai' };
    const rightAfter = { ...original, id: `${original.id}-right`, startMs: midpoint, sourceText: 'right', translatedText: 'phai' };

    let state = studioReducer(initial, { type: 'commitSplitMutation', originalBefore: original, leftAfter, rightAfter });
    expect(state.history.past).toHaveLength(1);
    expect(state.project.segments.some((segment) => segment.id === rightAfter.id)).toBe(true);

    state = studioReducer(state, { type: 'setPlaying', playing: true });
    state = studioReducer(state, { type: 'setTimelineZoom', pixelsPerSecond: 2 });
    expect(state.history.past).toHaveLength(1);

    state = studioReducer(state, { type: 'applyUndoLocal' });
    expect(state.project.segments.some((segment) => segment.id === rightAfter.id)).toBe(false);
    expect(state.history.past).toHaveLength(0);
    expect(state.history.future).toHaveLength(1);

    state = studioReducer(state, { type: 'applyRedoLocal' });
    expect(state.project.segments.some((segment) => segment.id === rightAfter.id)).toBe(true);
    expect(state.history.past).toHaveLength(1);
    expect(state.history.future).toHaveLength(0);
  });

  it('hydrates a persisted cloud project while retaining a matching selection and stopping playback', () => {
    let state = createInitialStudioState(mockProject);
    state = studioReducer(state, { type: 'selectSegment', segmentId: 's2' });
    state = studioReducer(state, { type: 'setPlaying', playing: true });
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
    expect(next.playback.playing).toBe(false);
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
