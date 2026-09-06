import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StudioShell } from './StudioShell';
import { createInitialStudioState } from './studioState';
import { mockProject } from './mockProject';

function render(projectId: string) {
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

describe('Phase 4C Studio multi-language mount', () => {
  it('mounts target-language and batch-export controls only for cloud projects', () => {
    const cloud = render('cloud-phase4c');
    expect(cloud).toContain('data-testid="target-languages-panel"');
    expect(cloud).toContain('data-testid="batch-export-panel"');
    expect(cloud).toContain('Ngôn ngữ đang chỉnh sửa');

    const demo = render('demo');
    expect(demo).not.toContain('data-testid="target-languages-panel"');
    expect(demo).not.toContain('data-testid="batch-export-panel"');
  });
});
