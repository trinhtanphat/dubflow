import type { Segment } from './types';
import { SegmentBlock } from './SegmentBlock';

type TimelineTrackProps = {
  segments: Segment[];
  pixelsPerSecond: number;
  selectedSegmentId: string;
  lane: 'source' | 'target';
  onSelect: (segmentId: string) => void;
};

export function TimelineTrack({ segments, pixelsPerSecond, selectedSegmentId, lane, onSelect }: TimelineTrackProps) {
  return (
    <div className="timeline-content-row segment-lane">
      {segments.map((segment) => (
        <SegmentBlock
          key={segment.id}
          segment={segment}
          pixelsPerSecond={pixelsPerSecond}
          selected={segment.id === selectedSegmentId}
          lane={lane}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
