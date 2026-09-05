import { describe, expect, it } from 'vitest';
import { MAX_PIXELS_PER_SECOND, MIN_PIXELS_PER_SECOND } from '../features/timeline/math';
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

    const rated = studioReducer(initial, { type: 'setPlaybackRate', rate: 1.5 });
    expect(rated.playback.rate).toBe(1.5);

    const tooLoud = studioReducer(initial, { type: 'setVolume', volume: 2 });
    expect(tooLoud.playback.volume).toBe(1);
    const tooQuiet = studioReducer(initial, { type: 'setVolume', volume: -1 });
    expect(tooQuiet.playback.volume).toBe(0);

    const muted = studioReducer(initial, { type: 'toggleMuted' });
    expect(muted.playback.muted).toBe(true);
  });

  it('keeps timeline viewport state transient and bounded', () => {
    const initial = createInitialStudioState(mockProject);
    expect(initial.timelineView).toEqual({ pixelsPerSecond: 1, scrollLeft: 0, viewportWidth: 0 });

    const zoomedOut = studioReducer(initial, { type: 'setTimelineZoom', pixelsPerSecond: 0 });
    expect(zoomedOut.timelineView.pixelsPerSecond).toBe(MIN_PIXELS_PER_SECOND);
    const zoomedIn = studioReducer(initial, { type: 'setTimelineZoom', pixelsPerSecond: 1000 });
    expect(zoomedIn.timelineView.pixelsPerSecond).toBe(MAX_PIXELS_PER_SECOND);

    const scrolled = studioReducer(initial, { type: 'setTimelineScroll', scrollLeft: -50 });
    expect(scrolled.timelineView.scrollLeft).toBe(0);
    const resized = studioReducer(initial, { type: 'setTimelineViewport', viewportWidth: -100 });
    expect(resized.timelineView.viewportWidth).toBe(0);
    expect(resized.project).toBe(initial.project);
  });
});
