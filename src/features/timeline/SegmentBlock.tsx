import type { Segment } from './types';
import { timeToPixels } from './math';

type SegmentBlockProps = {
  segment: Segment;
  pixelsPerSecond: number;
  selected: boolean;
  lane: 'source' | 'target';
  onSelect: (segmentId: string) => void;
};

export function SegmentBlock({ segment, pixelsPerSecond, selected, lane, onSelect }: SegmentBlockProps) {
  const left = timeToPixels(segment.startMs, pixelsPerSecond);
  const width = Math.max(2, timeToPixels(segment.endMs - segment.startMs, pixelsPerSecond));
  const text = lane === 'source' ? segment.sourceText : segment.translatedText;
  return (
    <button
      type="button"
      className={`segment-block segment-block--${lane} ${selected ? 'is-selected' : ''}`}
      style={{ left: `${left}px`, width: `${width}px` }}
      onClick={() => onSelect(segment.id)}
      title={text}
    >
      {text}
    </button>
  );
}
