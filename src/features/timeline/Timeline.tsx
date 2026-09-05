import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent, UIEvent } from 'react';
import type { StudioAction, StudioState } from '../../app/studioState';
import {
  chooseRulerIntervalSeconds,
  fitPixelsPerSecond,
  pixelsToTime,
  pointerXToTime,
  projectWidthPx,
  timeToPixels,
} from './math';
import { TimelineTrack } from './TimelineTrack';
import { WaveformTrack } from './WaveformTrack';
import type { StudioProject } from './types';

type TimelineProps = {
  project: StudioProject;
  playheadMs: number;
  selectedSegmentId: string;
  timelineView: StudioState['timelineView'];
  dispatch: Dispatch<StudioAction>;
};

type RulerMark = { timeMs: number; label: string };

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

export function Timeline({ project, playheadMs, selectedSegmentId, timelineView, dispatch }: TimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
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
  const select = (segmentId: string) => dispatch({ type: 'selectSegment', segmentId });

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
    <section className="timeline-panel" aria-label="Timeline">
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
            <div className="timeline-playhead" style={{ left: playheadLeft }} aria-label="Playhead"><i /></div>
            <div className="timeline-content-row video-thumbnails">
              {Array.from({ length: 12 }, (_, i) => <i key={i}><span>{i + 1}</span></i>)}
            </div>
            <TimelineTrack
              lane="source"
              segments={project.segments}
              pixelsPerSecond={pixelsPerSecond}
              selectedSegmentId={selectedSegmentId}
              onSelect={select}
            />
            <TimelineTrack
              lane="target"
              segments={project.segments}
              pixelsPerSecond={pixelsPerSecond}
              selectedSegmentId={selectedSegmentId}
              onSelect={select}
            />
            {project.speakers.map((speaker, index) => <WaveformTrack key={speaker.id} speaker={speaker} index={index} />)}
          </div>
        </div>
      </div>
    </section>
  );
}
