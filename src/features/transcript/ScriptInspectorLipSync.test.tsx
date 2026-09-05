import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScriptInspector } from './ScriptInspector';

const segment = {
  id: 'seg-lipsync',
  speakerId: 'speaker-1',
  startMs: 1000,
  endMs: 3000,
  sourceText: '你好',
  translatedText: 'Xin chào',
  version: 1,
};
const speakers = [{ id: 'speaker-1', name: 'Nhân vật 1', label: 'Nữ chính', share: 1 }];

function renderInspector(visualLipSyncAvailable?: boolean, lipSyncEnabled = false) {
  return renderToStaticMarkup(
    <ScriptInspector
      segment={segment}
      speakers={speakers}
      lipSyncEnabled={lipSyncEnabled}
      visualLipSyncAvailable={visualLipSyncAvailable}
      dispatch={() => {}}
    />,
  );
}

describe('visual lip-sync capability boundary', () => {
  it('fails closed by default when no verified backend capability is supplied', () => {
    const html = renderInspector();
    expect(html).toContain('Visual lip-sync chưa khả dụng trên backend hiện tại.');
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Bật hoặc tắt đồng bộ khẩu hình"/);
    expect(html).toContain('aria-pressed="false"');
  });

  it('keeps an unavailable visual toggle off even if the stored preference is true', () => {
    const html = renderInspector(false, true);
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Bật hoặc tắt đồng bộ khẩu hình"/);
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('toggle is-on');
  });

  it('enables the existing visual toggle only when capability is explicitly verified', () => {
    const html = renderInspector(true, true);
    expect(html).toMatch(/<button[^>]*aria-label="Bật hoặc tắt đồng bộ khẩu hình"[^>]*aria-pressed="true"/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*aria-label="Bật hoặc tắt đồng bộ khẩu hình"/);
    expect(html).toContain('toggle is-on');
  });
});
