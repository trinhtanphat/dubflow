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

  it('shows bounded live cloud progress without losing the processing state', () => {
    const html = renderToStaticMarkup(
      <StudioTopbar
        projectTitle="Cloud episode"
        saveState="offline"
        cloudState="processing"
        cloudProgress={0.47}
        cloudDetail="transcribing"
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
      />,
    );
    expect(html).toContain('Processing');
    expect(html).toContain('47%');
    expect(html).toContain('transcribing');
  });
});
