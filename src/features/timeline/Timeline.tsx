import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, UIEvent } from 'react';
import type { StudioAction, StudioState } from '../../app/studioState';
import {
  MIN_SEGMENT_MS,
  clampMoveTiming,
  clampResizeTiming,
  snapEdgeTime,
  type SegmentTiming,
  type TimingNeighbors,
} from './editing';
import {
  chooseRulerIntervalSeconds,
  fitPixelsPerSecond,
  pixelsToTime,
  pointerXToTime,
  projectWidthPx,
  timeToPixels,
} from './math';
import type { SegmentEditMode, SegmentPointerIntent } from './SegmentBlock';
import { TimelineTrack } from './TimelineTrack';
import { WaveformTrack } from './WaveformTrack';
import type { Segment, StudioProject } from './types';

export type SegmentEditIntent =
  | { kind: 'move'; segmentId: string; startMs: number; endMs: number }
  | { kind: 'resize'; segmentId: string; edge: 'left' | 'right'; startMs: number; endMs: number };

type TimelineProps = {
  project: StudioProject;
  playheadMs: number;
  selectedSegmentId: string;
  timelineView: StudioState['timelineView'];
  segmentPreview?: StudioState['segmentPreview'];
  dispatch: Dispatch<StudioAction>;
  onCommitSegmentEdit?: (intent: SegmentEditIntent) => void;
  onSplitSelected?: () => void;
};

type RulerMark = { timeMs: number; label: string };
type ActiveSegmentEdit = {
  segmentId: string;
  mode: SegmentEditMode;
  pointerId: number;
  startClientX: number;
  original: SegmentTiming;
  neighbors: TimingNeighbors;
  snapPlayheadMs: number;
};

function formatRulerLabel(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildVisibleRulerMarks(
  durationMs: number,
  pixelsPerSecond: number,
  scrollLeft: number,
  viewportWidth: number,
): RulerMark[] {
  const stepMs = chooseRulerIntervalSeconds(pixelsPerSecond) * 1000;
  const safeViewportWidth = Math.max(1, viewportWidth || 1000);
  const visibleStartMs = pixelsToTime(scrollLeft, pixelsPerSecond);
  const visibleEndMs = Math.min(durationMs, pixelsToTime(scrollLeft + safeViewportWidth, pixelsPerSecond));
  const firstMarkMs = Math.max(0, Math.floor(visibleStartMs / stepMs) * stepMs);
  const marks: RulerMark[] = [];
  const maxMarks = Math.ceil(safeViewportWidth / 80) + 3;

  for (let timeMs = firstMarkMs; timeMs <= visibleEndMs + stepMs && marks.length < maxMarks; timeMs += stepMs) {
    if (timeMs <= durationMs) marks.push({ timeMs, label: formatRulerLabel(timeMs) });
  }

  return marks;
}

function timingNeighbors(project: StudioProject, segmentId: string): TimingNeighbors | null {
  const segments = [...project.segments].sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return null;
  return {
    previousEndMs: segments[index - 1]?.endMs ?? 0,
    nextStartMs: segments[index + 1]?.startMs ?? project.durationMs,
  };
}

function snapCandidates(targetMs: number, neighbors: TimingNeighbors, playheadMs: number) {
  return [
    { timeMs: neighbors.previousEndMs, kind: 'neighbor' as const },
    { timeMs: neighbors.nextStartMs, kind: 'neighbor' as const },
    { timeMs: playheadMs, kind: 'playhead' as const },
    { timeMs: Math.round(targetMs / 100) * 100, kind: 'grid' as const },
  ];
}

function snapAdjustment(
  targetMs: number,
  neighbors: TimingNeighbors,
  playheadMs: number,
  pixelsPerSecond: number,
): number | null {
  const candidates = snapCandidates(targetMs, neighbors, playheadMs);
  const snapped = snapEdgeTime(targetMs, candidates, pixelsPerSecond);
  if (snapped !== targetMs) return snapped - targetMs;
  return candidates.some((candidate) => candidate.timeMs === targetMs) ? 0 : null;
}

function computeEditTiming(
  active: ActiveSegmentEdit,
  clientX: number,
  pixelsPerSecond: number,
  projectDurationMs: number,
): SegmentTiming {
  const deltaMs = Number.isFinite(clientX)
    ? (clientX - active.startClientX) / pixelsPerSecond * 1000
    : 0;

  if (active.mode === 'move') {
    const base = clampMoveTiming(active.original, deltaMs, active.neighbors, projectDurationMs);
    const startAdjustment = snapAdjustment(base.startMs, active.neighbors, active.snapPlayheadMs, pixelsPerSecond);
    const endAdjustment = snapAdjustment(base.endMs, active.neighbors, active.snapPlayheadMs, pixelsPerSecond);
    const adjustments = [startAdjustment, endAdjustment].filter((value): value is number => value !== null);
    const adjustment = adjustments.sort((left, right) => Math.abs(left) - Math.abs(right))[0] ?? 0;
    return clampMoveTiming(
      active.original,
      (base.startMs - active.original.startMs) + adjustment,
      active.neighbors,
      projectDurationMs,
    );
  }

  const edge = active.mode === 'resize-left' ? 'left' : 'right';
  const target = (edge === 'left' ? active.original.startMs : active.original.endMs) + deltaMs;
  const snappedTarget = snapEdgeTime(
    target,
    snapCandidates(target, active.neighbors, active.snapPlayheadMs),
    pixelsPerSecond,
  );
  return clampResizeTiming(active.original, edge, snappedTarget, active.neighbors, projectDurationMs);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function Timeline({
  project,
  playheadMs,
  selectedSegmentId,
  timelineView,
  segmentPreview,
  dispatch,
  onCommitSegmentEdit,
  onSplitSelected,
}: TimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const activePlayheadPointerId = useRef<number | null>(null);
  const activeSegmentEdit = useRef<ActiveSegmentEdit | null>(null);
  const pixelsPerSecond = timelineView.pixelsPerSecond;
  const canvasWidth = Math.max(projectWidthPx(project.durationMs, pixelsPerSecond), timelineView.viewportWidth || 1);
  const playheadLeft = timeToPixels(playheadMs, pixelsPerSecond);
  const marks = useMemo(
    () => buildVisibleRulerMarks(
      project.durationMs,
      pixelsPerSecond,
      timelineView.scrollLeft,
      timelineView.viewportWidth,
    ),
    [project.durationMs, pixelsPerSecond, timelineView.scrollLeft, timelineView.viewportWidth],
  );
  const select = (segmentId: string) => {
    if (segmentId !== selectedSegmentId) dispatch({ type: 'selectSegment', segmentId });
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const reportViewport = () => dispatch({ type: 'setTimelineViewport', viewportWidth: viewport.clientWidth });
    reportViewport();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportViewport);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [dispatch]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || Math.abs(viewport.scrollLeft - timelineView.scrollLeft) < 1) return;
    viewport.scrollLeft = timelineView.scrollLeft;
  }, [timelineView.scrollLeft]);

  const seekFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const targetMs = pointerXToTime(
      event.clientX,
      viewport.getBoundingClientRect().left,
      viewport.scrollLeft,
      pixelsPerSecond,
    );
    dispatch({ type: 'setPlayhead', playheadMs: Math.max(0, Math.min(project.durationMs, targetMs)) });
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, [data-timeline-interactive="true"]')) return;
    seekFromPointer(event);
  };

  const handlePlayheadPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    activePlayheadPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekFromPointer(event);
  };

  const handlePlayheadPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (activePlayheadPointerId.current !== event.pointerId) return;
    event.stopPropagation();
    seekFromPointer(event);
  };

  const finishPlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>, applyFinalPosition: boolean) => {
    if (activePlayheadPointerId.current !== event.pointerId) return;
    event.stopPropagation();
    if (applyFinalPosition) seekFromPointer(event);
    activePlayheadPointerId.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const handlePlayheadKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape' || activePlayheadPointerId.current === null) return;
    const pointerId = activePlayheadPointerId.current;
    activePlayheadPointerId.current = null;
    if (event.currentTarget.hasPointerCapture?.(pointerId)) {
      event.currentTarget.releasePointerCapture?.(pointerId);
    }
  };

  const handleSegmentEditStart = (intent: SegmentPointerIntent) => {
    const segment = project.segments.find((item) => item.id === intent.segmentId);
    const neighbors = timingNeighbors(project, intent.segmentId);
    if (!segment || !neighbors) return;
    activeSegmentEdit.current = {
      segmentId: intent.segmentId,
      mode: intent.mode,
      pointerId: intent.pointerId,
      startClientX: intent.clientX,
      original: { startMs: segment.startMs, endMs: segment.endMs },
      neighbors,
      snapPlayheadMs: playheadMs,
    };
  };

  const previewSegmentEdit = (intent: SegmentPointerIntent): SegmentTiming | null => {
    const active = activeSegmentEdit.current;
    if (!active || active.pointerId !== intent.pointerId || active.segmentId !== intent.segmentId || active.mode !== intent.mode) return null;
    const timing = computeEditTiming(active, intent.clientX, pixelsPerSecond, project.durationMs);
    dispatch({ type: 'previewSegmentTiming', segmentId: intent.segmentId, ...timing });
    return timing;
  };

  const handleSegmentEditCommit = (intent: SegmentPointerIntent) => {
    const active = activeSegmentEdit.current;
    const timing = previewSegmentEdit(intent);
    if (!active || !timing) return;
    activeSegmentEdit.current = null;
    if (!onCommitSegmentEdit) {
      dispatch({ type: 'cancelSegmentPreview' });
      return;
    }
    if (active.mode === 'move') {
      onCommitSegmentEdit({ kind: 'move', segmentId: active.segmentId, ...timing });
    } else {
      onCommitSegmentEdit({
        kind: 'resize',
        segmentId: active.segmentId,
        edge: active.mode === 'resize-left' ? 'left' : 'right',
        ...timing,
      });
    }
  };

  const handleSegmentEditCancel = (intent: Omit<SegmentPointerIntent, 'clientX'>) => {
    const active = activeSegmentEdit.current;
    if (!active || active.pointerId !== intent.pointerId || active.segmentId !== intent.segmentId) return;
    activeSegmentEdit.current = null;
    dispatch({ type: 'cancelSegmentPreview' });
  };

  const handleTimelineKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && activeSegmentEdit.current) {
      activeSegmentEdit.current = null;
      dispatch({ type: 'cancelSegmentPreview' });
      return;
    }
    if (event.key.toLowerCase() !== 's' || isTypingTarget(event.target) || !onSplitSelected) return;
    const segment = project.segments.find((item) => item.id === selectedSegmentId);
    if (!segment) return;
    if (playheadMs - segment.startMs < MIN_SEGMENT_MS || segment.endMs - playheadMs < MIN_SEGMENT_MS) return;
    event.preventDefault();
    onSplitSelected();
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    dispatch({ type: 'setTimelineScroll', scrollLeft: event.currentTarget.scrollLeft });
  };

  const fitProject = () => {
    const viewportWidth = viewportRef.current?.clientWidth ?? timelineView.viewportWidth;
    dispatch({
      type: 'setTimelineZoom',
      pixelsPerSecond: fitPixelsPerSecond(project.durationMs, viewportWidth),
    });
    dispatch({ type: 'setTimelineScroll', scrollLeft: 0 });
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
  };

  return (
    <section
      className="timeline-panel reference-timeline"
      aria-label="Timeline"
      data-segment-editing="true"
      onKeyDown={handleTimelineKeyDown}
    >
      <div className="timeline-title">
        <strong>Timeline</strong>
        <div className="timeline-toolbar" aria-label="Điều khiển timeline">
          <button type="button" aria-label="Thu nhỏ timeline" onClick={() => dispatch({ type: 'setTimelineZoom', pixelsPerSecond: pixelsPerSecond / 1.25 })}>−</button>
          <button type="button" aria-label="Vừa toàn dự án" onClick={fitProject}>Fit</button>
          <button type="button" aria-label="Phóng to timeline" onClick={() => dispatch({ type: 'setTimelineZoom', pixelsPerSecond: pixelsPerSecond * 1.25 })}>+</button>
        </div>
      </div>

      <div className="timeline-workspace">
        <div className="timeline-labels" aria-hidden="true">
          <div className="timeline-label-spacer" />
          <div className="track-label">▣ Video</div>
          <div className="track-label">▧ Phụ đề gốc</div>
          <div className="track-label">◉ Dịch &amp; phụ đề</div>
          {project.speakers.map((speaker) => <div className="track-label" key={speaker.id}>◉ {speaker.name}</div>)}
        </div>

        <div
          ref={viewportRef}
          className="timeline-scroll-viewport"
          data-timeline-viewport="true"
          onScroll={handleScroll}
        >
          <div
            className="timeline-canvas"
            data-timeline-canvas="true"
            style={{ width: canvasWidth }}
            onPointerDown={handleCanvasPointerDown}
          >
            <div className="ruler-content timeline-content-row">
              {marks.map((mark) => (
                <span key={mark.timeMs} style={{ left: timeToPixels(mark.timeMs, pixelsPerSecond) }}>{mark.label}</span>
              ))}
            </div>
            <div className="timeline-playhead reference-playhead" style={{ left: playheadLeft }}>
              <button
                type="button"
                className="timeline-playhead-handle"
                aria-label="Kéo playhead"
                data-timeline-playhead-handle="true"
                data-timeline-interactive="true"
                onPointerDown={handlePlayheadPointerDown}
                onPointerMove={handlePlayheadPointerMove}
                onPointerUp={(event) => finishPlayheadDrag(event, true)}
                onPointerCancel={(event) => finishPlayheadDrag(event, false)}
                onKeyDown={handlePlayheadKeyDown}
              />
            </div>
            <div className="timeline-content-row video-thumbnails">
              {Array.from({ length: 12 }, (_, i) => <i key={i}><span>{i + 1}</span></i>)}
            </div>
            <TimelineTrack
              lane="source"
              segments={project.segments}
              pixelsPerSecond={pixelsPerSecond}
              selectedSegmentId={selectedSegmentId}
              segmentPreview={segmentPreview}
              onSelect={select}
              onEditStart={handleSegmentEditStart}
              onEditPreview={previewSegmentEdit}
              onEditCommit={handleSegmentEditCommit}
              onEditCancel={handleSegmentEditCancel}
            />
            <TimelineTrack
              lane="target"
              segments={project.segments}
              pixelsPerSecond={pixelsPerSecond}
              selectedSegmentId={selectedSegmentId}
              segmentPreview={segmentPreview}
              onSelect={select}
              onEditStart={handleSegmentEditStart}
              onEditPreview={previewSegmentEdit}
              onEditCommit={handleSegmentEditCommit}
              onEditCancel={handleSegmentEditCancel}
            />
            {project.speakers.map((speaker, index) => <WaveformTrack key={speaker.id} speaker={speaker} index={index} />)}
          </div>
        </div>
      </div>
    </section>
  );
}
