import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Segment } from './types';
import { timeToPixels } from './math';

export type SegmentEditMode = 'move' | 'resize-left' | 'resize-right';
export type SegmentPointerIntent = {
  segmentId: string;
  mode: SegmentEditMode;
  pointerId: number;
  clientX: number;
};

export type SegmentBlockProps = {
  segment: Segment;
  previewTiming?: { startMs: number; endMs: number } | null;
  pixelsPerSecond: number;
  selected: boolean;
  lane: 'source' | 'target';
  onSelect: (segmentId: string) => void;
  onEditStart?: (intent: SegmentPointerIntent) => void;
  onEditPreview?: (intent: SegmentPointerIntent) => void;
  onEditCommit?: (intent: SegmentPointerIntent) => void;
  onEditCancel?: (intent: Omit<SegmentPointerIntent, 'clientX'>) => void;
};

export function SegmentBlock({
  segment,
  previewTiming,
  pixelsPerSecond,
  selected,
  lane,
  onSelect,
  onEditStart,
  onEditPreview,
  onEditCommit,
  onEditCancel,
}: SegmentBlockProps) {
  const timing = previewTiming ?? segment;
  const left = timeToPixels(timing.startMs, pixelsPerSecond);
  const width = Math.max(2, timeToPixels(timing.endMs - timing.startMs, pixelsPerSecond));
  const text = lane === 'source' ? segment.sourceText : segment.translatedText;

  const start = (mode: SegmentEditMode, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect(segment.id);
    event.currentTarget.dataset.segmentPointerId = String(event.pointerId);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onEditStart?.({ segmentId: segment.id, mode, pointerId: event.pointerId, clientX: event.clientX });
  };

  const preview = (mode: SegmentEditMode, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.dataset.segmentPointerId !== String(event.pointerId)) return;
    event.stopPropagation();
    onEditPreview?.({ segmentId: segment.id, mode, pointerId: event.pointerId, clientX: event.clientX });
  };

  const finish = (mode: SegmentEditMode, event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    if (event.currentTarget.dataset.segmentPointerId !== String(event.pointerId)) return;
    event.stopPropagation();
    if (cancelled) {
      onEditCancel?.({ segmentId: segment.id, mode, pointerId: event.pointerId });
    } else {
      onEditCommit?.({ segmentId: segment.id, mode, pointerId: event.pointerId, clientX: event.clientX });
    }
    delete event.currentTarget.dataset.segmentPointerId;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const cancelFromKeyboard = (mode: SegmentEditMode, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape') return;
    const rawPointerId = event.currentTarget.dataset.segmentPointerId;
    if (!rawPointerId) return;
    const pointerId = Number(rawPointerId);
    onEditCancel?.({ segmentId: segment.id, mode, pointerId });
    delete event.currentTarget.dataset.segmentPointerId;
    if (event.currentTarget.hasPointerCapture?.(pointerId)) {
      event.currentTarget.releasePointerCapture?.(pointerId);
    }
  };

  const interactionProps = (mode: SegmentEditMode) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => start(mode, event),
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => preview(mode, event),
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => finish(mode, event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => finish(mode, event, true),
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => cancelFromKeyboard(mode, event),
  });

  return (
    <div
      className={`segment-block segment-block--${lane} ${selected ? 'is-selected' : ''} ${previewTiming ? 'is-previewing' : ''}`}
      style={{ left: `${left}px`, width: `${width}px` }}
      title={text}
      data-segment-id={segment.id}
      data-timeline-interactive="true"
    >
      <button
        type="button"
        className="segment-block__body"
        data-segment-drag-handle="true"
        data-timeline-interactive="true"
        aria-label="Di chuyển đoạn phụ đề"
        onClick={() => onSelect(segment.id)}
        {...interactionProps('move')}
      >
        {text}
      </button>
      {selected ? (
        <>
          <button
            type="button"
            className="segment-resize-handle segment-resize-handle--left"
            data-segment-resize-left="true"
            data-timeline-interactive="true"
            aria-label="Chỉnh mép trái đoạn phụ đề"
            {...interactionProps('resize-left')}
          />
          <button
            type="button"
            className="segment-resize-handle segment-resize-handle--right"
            data-segment-resize-right="true"
            data-timeline-interactive="true"
            aria-label="Chỉnh mép phải đoạn phụ đề"
            {...interactionProps('resize-right')}
          />
        </>
      ) : null}
    </div>
  );
}
