import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent, UIEvent } from 'react';
import type { StudioAction, StudioState } from '../../app/studioState';
import { fitPixelsPerSecond, pixelsToTime, projectWidthPx, timeToPixels } from './math';
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

function rulerStepMs(pixelsPerSecond: number): number {
  const candidates = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  return candidates.find((step) => timeToPixels(step, pixelsPerSecond) >= 72) ?? candidates[candidates.length - 1]!;
}

function buildRulerMarks(durationMs: number, pixelsPerSecond: number): RulerMark[] {
  const step = rulerStepMs(pixelsPerSecond);
  const marks: RulerMark[] = [];
  for (let timeMs = 0; timeMs <= durationMs; timeMs += step) {
    marks.push({ timeMs, label: formatRulerLabel(timeMs) });
  }
  if (marks.at(-1)?.timeMs !== durationMs) {
    marks.push({ timeMs: durationMs, label: formatRulerLabel(durationMs) });
  }
  return marks;
}

export function Timeline({ project, playheadMs, selectedSegmentId, timelineView, dispatch }: TimelineProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const draggingPlayhead = useRef(false);
  const pixelsPerSecond = timelineView.pixelsPerSecond;
  const canvasWidth = Math.max(projectWidthPx(project.durationMs, pixelsPerSecond), timelineView.viewportWidth || 1);
  const playheadLeft = timeToPixels(playheadMs, pixelsPerSecond);
  const marks = useMemo(
    () => buildRulerMarks(project.durationMs, pixelsPerSecond),
    [project.durationMs, pixelsPerSecond],
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

  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localPx = Math.max(0, Math.min(canvasWidth, event.clientX - rect.left));
    dispatch({ type: 'setPlayhead', playheadMs: pixelsToTime(localPx, pixelsPerSecond) });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    draggingPlayhead.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekFromPointer(event);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingPlayhead.current) return;
    seekFromPointer(event);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingPlayhead.current) return;
    seekFromPointer(event);
    draggingPlayhead.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
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
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => { draggingPlayhead.current = false; }}
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
