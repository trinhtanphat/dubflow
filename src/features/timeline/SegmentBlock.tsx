import type { Segment } from './types';
import { timeToPercent } from './math';

type Props = { segment: Segment; durationMs: number; selected: boolean; className?: string; text: string; onSelect: () => void };

export function SegmentBlock({ segment, durationMs, selected, className = '', text, onSelect }: Props) {
  const left = timeToPercent(segment.startMs, durationMs);
  const width = timeToPercent(segment.endMs - segment.startMs, durationMs);
  return <button type="button" className={`segment-block ${className} ${selected ? 'selected' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} onClick={onSelect}>{text}</button>;
}
