import type { Segment } from './types';
import { timeToPercent } from './math';

type SegmentBlockProps = { segment: Segment; durationMs: number; selected: boolean; lane: 'source' | 'target'; onSelect: (segmentId: string) => void };
export function SegmentBlock({ segment, durationMs, selected, lane, onSelect }: SegmentBlockProps) {
  const left = timeToPercent(segment.startMs, durationMs);
  const width = Math.max(1.2, timeToPercent(segment.endMs - segment.startMs, durationMs));
  const text = lane === 'source' ? segment.sourceText : segment.translatedText;
  return <button type="button" className={`segment-block segment-block--${lane} ${selected ? 'is-selected' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} onClick={() => onSelect(segment.id)} title={text}>{text}</button>;
}
