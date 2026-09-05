import type { Dispatch } from 'react';
import type { StudioAction } from '../../app/studioState';
import { timeToPercent } from './math';
import { TimelineTrack } from './TimelineTrack';
import { WaveformTrack } from './WaveformTrack';
import type { StudioProject } from './types';

type TimelineProps = { project: StudioProject; playheadMs: number; selectedSegmentId: string; dispatch: Dispatch<StudioAction> };
export function Timeline({ project, playheadMs, selectedSegmentId, dispatch }: TimelineProps) {
  const playhead = timeToPercent(playheadMs, project.durationMs);
  const marks = [0, 10, 20, 30, 40, 45];
  const select = (segmentId: string) => dispatch({ type: 'selectSegment', segmentId });
  return <section className="timeline-panel" aria-label="Timeline"><div className="timeline-title"><strong>Timeline</strong><span>00:00</span><span>45:23</span></div><div className="timeline-ruler"><div className="track-label" /><div className="ruler-content">{marks.map((mark) => <span key={mark} style={{ left: `${mark / 45 * 100}%` }}>{String(mark).padStart(2, '0')}:00</span>)}</div></div><div className="timeline-body"><div className="timeline-playhead" style={{ left: `calc(132px + (100% - 132px) * ${playhead / 100})` }}><i /></div><div className="timeline-row video-strip-row"><div className="track-label">▣ Video</div><div className="track-content video-thumbnails">{Array.from({ length: 12 }, (_, i) => <i key={i}><span>{i + 1}</span></i>)}</div></div><TimelineTrack label="▧ Phụ đề gốc" lane="source" segments={project.segments} durationMs={project.durationMs} selectedSegmentId={selectedSegmentId} onSelect={select} /><TimelineTrack label="◉ Dịch & phụ đề" lane="target" segments={project.segments} durationMs={project.durationMs} selectedSegmentId={selectedSegmentId} onSelect={select} />{project.speakers.map((speaker, index) => <WaveformTrack key={speaker.id} speaker={speaker} index={index} />)}</div></section>;
}
