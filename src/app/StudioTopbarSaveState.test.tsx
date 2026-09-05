import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StudioTopbar, type SaveState } from './StudioTopbar';

function render(saveState: SaveState) {
  return renderToStaticMarkup(
    <StudioTopbar
      projectTitle="P"
      saveState={saveState}
      cloudState="ready"
      canUndo={false}
      canRedo={false}
      onUndo={() => {}}
      onRedo={() => {}}
      onOpenCommands={() => {}}
    />,
  );
}

describe('StudioTopbar V2.5 save states', () => {
  it('shows truthful dirty/saving/error/conflict copy while preserving Saved compatibility', () => {
    expect(render('saved')).toContain('Đã lưu');
    expect(render('dirty')).toContain('Chưa lưu');
    expect(render('saving')).toContain('Đang lưu…');
    expect(render('error')).toContain('Lỗi lưu');
    expect(render('conflict')).toContain('Xung đột');
  });
});
