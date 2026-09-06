import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StudioTopbar } from './StudioTopbar';

function render(exportHref?: string, canShare = false) {
  return renderToStaticMarkup(
    <StudioTopbar
      projectTitle="Sharing"
      saveState="saved"
      cloudState="ready"
      canUndo={false}
      canRedo={false}
      exportHref={exportHref}
      canShare={canShare}
      onShare={vi.fn()}
      onUndo={() => {}}
      onRedo={() => {}}
      onOpenCommands={() => {}}
    />,
  );
}

describe('Studio sharing controls', () => {
  it('shows download and share together only after a durable export exists', () => {
    const html = render('/api/projects/p1/export/media', true);
    expect(html).toContain('Tải Dubbing');
    expect(html).toContain('Chia sẻ');
  });

  it('does not expose sharing before the durable export exists', () => {
    const html = render(undefined, false);
    expect(html).not.toContain('Chia sẻ');
  });
});
