import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockProject } from './mockProject';
import { createInitialStudioState } from './studioState';
import { StudioShell } from './StudioShell';

function renderProject(projectId: string) {
  const state = createInitialStudioState({ ...mockProject, id: projectId });
  return renderToStaticMarkup(
    <StudioShell
      state={state}
      dispatch={() => {}}
      selectedSegment={state.project.segments[0]}
      selectedSpeaker={state.project.speakers[0]}
    />,
  );
}

describe('StudioShell translation settings integration', () => {
  it('renders translation settings for a real cloud project', () => {
    const html = renderProject('cloud-p1');
    expect(html).toContain('data-testid="translation-settings-panel"');
  });

  it('does not expose server-backed translation settings for the demo project', () => {
    const html = renderProject('demo');
    expect(html).not.toContain('data-testid="translation-settings-panel"');
  });
});
