import type { Segment } from './types';
import { SegmentBlock } from './SegmentBlock';

type TimelineTrackProps = { label: string; segments: Segment[]; durationMs: number; selectedSegmentId: string; lane: 'source' | 'target'; onSelect: (segmentId: string) => void };
export function TimelineTrack({ label, segments, durationMs, selectedSegmentId, lane, onSelect }: TimelineTrackProps) {
  return <div className="timeline-row"><div className="track-label">{label}</div><div className="track-content segment-lane">{segments.map((segment) => <SegmentBlock key={segment.id} segment={segment} durationMs={durationMs} selected={segment.id === selectedSegmentId} lane={lane} onSelect={onSelect} />)}</div></div>;
}
