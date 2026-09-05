import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StudioTopbar } from './StudioTopbar';

describe('StudioTopbar', () => {
  it('renders truthful save/cloud state and accessible command control', () => {
    const html = renderToStaticMarkup(
      <StudioTopbar
        projectTitle="Tập 01"
        saveState="saved"
        cloudState="ready"
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
      />,
    );
    expect(html).toContain('Saved');
    expect(html).toContain('Cloud ready');
    expect(html).toContain('aria-label="Mở bảng lệnh"');
    expect(html).toContain('Tập 01');
  });
});
