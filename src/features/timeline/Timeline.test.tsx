import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StudioState } from '../../app/studioState';
import type { StudioProject } from './types';
import { Timeline } from './Timeline';

const project: StudioProject = {
  id: 'p1', title: 'Episode', durationMs: 10_000, sourceLanguage: 'zh', targetLanguage: 'vi',
  speakers: [{ id: 'speaker-1', name: 'Nhân vật 1', label: 'Nữ chính', share: 100 }],
  segments: [{ id: 's1', speakerId: 'speaker-1', startMs: 1_000, endMs: 3_000, sourceText: '原文', translatedText: 'Bản dịch' }],
};
const timelineView: StudioState['timelineView'] = { pixelsPerSecond: 50, scrollLeft: 0, viewportWidth: 500 };
const TestTimeline = Timeline as any;

describe('Timeline interactive viewport', () => {
  it('renders zoom controls and a project-width canvas', () => {
    const html = renderToStaticMarkup(
      <TestTimeline
        project={project}
        playheadMs={2_000}
        selectedSegmentId="s1"
        timelineView={timelineView}
        dispatch={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Thu nhỏ timeline"');
    expect(html).toContain('aria-label="Phóng to timeline"');
    expect(html).toContain('aria-label="Vừa toàn dự án"');
    expect(html).toContain('data-timeline-canvas="true"');
    expect(html).toContain('data-timeline-viewport="true"');
    expect(html).toContain('width:500px');
  });

  it('renders a dedicated accessible playhead drag handle', () => {
    const html = renderToStaticMarkup(
      <TestTimeline
        project={project}
        playheadMs={2_000}
        selectedSegmentId="s1"
        timelineView={timelineView}
        dispatch={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Kéo playhead"');
    expect(html).toContain('data-timeline-playhead-handle="true"');
  });

  it('keeps reference density hooks around the interactive V2.2 timeline', () => {
    const html = renderToStaticMarkup(
      <TestTimeline
        project={project}
        playheadMs={2_000}
        selectedSegmentId="s1"
        timelineView={timelineView}
        dispatch={() => {}}
      />,
    );
    expect(html).toContain('reference-timeline');
    expect(html).toContain('reference-playhead');
    expect(html).toContain('data-timeline-playhead-handle="true"');
  });

  it('renders one transient timing preview consistently on both subtitle lanes', () => {
    const html = renderToStaticMarkup(
      <TestTimeline
        project={project}
        playheadMs={2_000}
        selectedSegmentId="s1"
        timelineView={timelineView}
        segmentPreview={{ segmentId: 's1', startMs: 2_000, endMs: 4_000 }}
        dispatch={() => {}}
      />,
    );
    expect(html).toContain('data-segment-editing="true"');
    expect(
      html.match(/class="segment-block segment-block--(?:source|target)[^"]*is-previewing" style="left:100px/g)?.length,
    ).toBe(2);
    expect(html.match(/is-previewing/g)?.length).toBe(2);
  });
});
