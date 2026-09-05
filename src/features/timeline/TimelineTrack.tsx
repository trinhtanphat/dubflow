import type { Segment } from './types';
import { SegmentBlock, type SegmentBlockProps } from './SegmentBlock';

type TimelineTrackProps = {
  segments: Segment[];
  pixelsPerSecond: number;
  selectedSegmentId: string;
  lane: 'source' | 'target';
  segmentPreview?: { segmentId: string; startMs: number; endMs: number } | null;
  onSelect: (segmentId: string) => void;
  onEditStart?: SegmentBlockProps['onEditStart'];
  onEditPreview?: SegmentBlockProps['onEditPreview'];
  onEditCommit?: SegmentBlockProps['onEditCommit'];
  onEditCancel?: SegmentBlockProps['onEditCancel'];
};

export function TimelineTrack({
  segments,
  pixelsPerSecond,
  selectedSegmentId,
  lane,
  segmentPreview,
  onSelect,
  onEditStart,
  onEditPreview,
  onEditCommit,
  onEditCancel,
}: TimelineTrackProps) {
  return (
    <div className="timeline-content-row segment-lane">
      {segments.map((segment) => (
        <SegmentBlock
          key={segment.id}
          segment={segment}
          previewTiming={segmentPreview?.segmentId === segment.id ? segmentPreview : null}
          pixelsPerSecond={pixelsPerSecond}
          selected={segment.id === selectedSegmentId}
          lane={lane}
          onSelect={onSelect}
          onEditStart={onEditStart}
          onEditPreview={onEditPreview}
          onEditCommit={onEditCommit}
          onEditCancel={onEditCancel}
        />
      ))}
    </div>
  );
}
