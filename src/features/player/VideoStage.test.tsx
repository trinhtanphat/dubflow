import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StudioState } from '../../app/studioState';
import type { Segment, StudioProject } from '../timeline/types';
import { VideoStage } from './VideoStage';

const segment: Segment = {
  id: 's1', speakerId: 'speaker-1', startMs: 1000, endMs: 3000,
  sourceText: 'Lời gốc', translatedText: 'Bản dịch',
};
const playback: StudioState['playback'] = { playing: false, rate: 1, volume: 1, muted: false };
const baseProject: StudioProject = {
  id: 'p1', title: 'Episode', durationMs: 10_000, sourceLanguage: 'zh', targetLanguage: 'vi',
  speakers: [{ id: 'speaker-1', name: 'Nhân vật 1', label: 'Nữ chính', share: 100 }], segments: [segment],
};
const dispatch = () => {};
const Stage = VideoStage as any;

function render(project: StudioProject) {
  return renderToStaticMarkup(
    <Stage project={project} segment={segment} playheadMs={1000} playback={playback} dispatch={dispatch} durationMs={project.durationMs} />,
  );
}

describe('VideoStage media states', () => {
  it('renders a real same-origin video when source media is ready', () => {
    const html = render({ ...baseProject, sourceObjectKey: 'projects/p1/source/a.mp4', status: 'ready' });
    expect(html).toContain('<video');
    expect(html).toContain('class="studio-video"');
    expect(html).toContain('src="/api/projects/p1/media"');
    expect(html).toContain('aria-label="Video source"');
    expect(html).toContain('Lời gốc');
    expect(html).toContain('Bản dịch');
  });

  it('renders a truthful empty state without faux uploaded footage', () => {
    const html = render({ ...baseProject, sourceObjectKey: null, status: 'draft' });
    expect(html).toContain('Chưa có media phát được');
    expect(html).not.toContain('character--left');
  });

  it('renders processing when a project is not playable yet', () => {
    const html = render({ ...baseProject, sourceObjectKey: null, status: 'processing' });
    expect(html).toContain('Media đang được xử lý');
  });
});
