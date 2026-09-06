import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockProject } from './mockProject';
import { createInitialStudioState } from './studioState';
import { StudioShell } from './StudioShell';

describe('StudioShell sharing wiring', () => {
  it('exposes the share action only when the hydrated project has a durable export', () => {
    const state = createInitialStudioState({
      ...mockProject,
      id: 'cloud-share-project',
      status: 'completed',
      exportObjectKey: 'projects/cloud-share-project/export/dubbed.mp4',
    });

    const html = renderToStaticMarkup(
      <StudioShell
        state={state}
        dispatch={() => {}}
        selectedSegment={state.project.segments[0]}
        selectedSpeaker={state.project.speakers[0]}
      />,
    );

    expect(html).toContain('/api/projects/cloud-share-project/export/media');
    expect(html).toContain('Chia sẻ');
    expect(html).not.toContain('aria-label="Chia sẻ video dubbing"');
  });

  it('keeps share controls hidden for a project without a published export', () => {
    const state = createInitialStudioState({
      ...mockProject,
      id: 'cloud-unpublished-project',
      exportObjectKey: null,
    });

    const html = renderToStaticMarkup(
      <StudioShell
        state={state}
        dispatch={() => {}}
        selectedSegment={state.project.segments[0]}
        selectedSpeaker={state.project.speakers[0]}
      />,
    );

    expect(html).not.toContain('Chia sẻ');
  });
});
