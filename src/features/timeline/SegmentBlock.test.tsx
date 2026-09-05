import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SegmentBlock } from './SegmentBlock';

const segment = {
  id: 's1',
  speakerId: 'speaker-1',
  startMs: 1000,
  endMs: 3000,
  sourceText: 'Original subtitle',
  translatedText: 'Bản dịch',
};

const TestSegmentBlock = SegmentBlock as any;

describe('SegmentBlock direct manipulation surface', () => {
  it('renders one body drag surface and two accessible resize handles when selected', () => {
    const html = renderToStaticMarkup(
      <TestSegmentBlock
        segment={segment}
        pixelsPerSecond={50}
        selected
        lane="source"
        onSelect={() => {}}
        onEditStart={() => {}}
        onEditPreview={() => {}}
        onEditCommit={() => {}}
        onEditCancel={() => {}}
      />,
    );

    expect(html).toContain('data-segment-drag-handle="true"');
    expect(html).toContain('aria-label="Di chuyển đoạn phụ đề"');
    expect(html).toContain('data-segment-resize-left="true"');
    expect(html).toContain('aria-label="Chỉnh mép trái đoạn phụ đề"');
    expect(html).toContain('data-segment-resize-right="true"');
    expect(html).toContain('aria-label="Chỉnh mép phải đoạn phụ đề"');
  });

  it('uses preview timing for visual position without mutating the segment input', () => {
    const html = renderToStaticMarkup(
      <TestSegmentBlock
        segment={segment}
        previewTiming={{ startMs: 1500, endMs: 3500 }}
        pixelsPerSecond={50}
        selected
        lane="target"
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('left:75px');
    expect(html).toContain('width:100px');
    expect(segment.startMs).toBe(1000);
    expect(segment.endMs).toBe(3000);
  });
});
