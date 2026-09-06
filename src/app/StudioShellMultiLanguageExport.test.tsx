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

describe('StudioShell multilingual export integration', () => {
  it('renders the Phase 4C export panel for a cloud project', () => {
    const html = renderProject('cloud-p1');
    expect(html).toContain('data-testid="multi-language-export-panel"');
  });

  it('keeps server-backed multilingual export hidden for the demo project', () => {
    const html = renderProject('demo');
    expect(html).not.toContain('data-testid="multi-language-export-panel"');
  });
});
