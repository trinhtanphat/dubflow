import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INSPECTOR_TABS, ScriptInspector } from './ScriptInspector';

const segment = {
  id: 'seg-tabs',
  speakerId: 'speaker-1',
  startMs: 1000,
  endMs: 3000,
  sourceText: '你好',
  translatedText: 'Xin chào',
  version: 1,
};
const speakers = [{ id: 'speaker-1', name: 'Nhân vật 1', label: 'Nữ chính', share: 1 }];

describe('Studio Pro V2 inspector tabs', () => {
  it('defines exactly Script, Characters, Voice and AI in the approved order', () => {
    expect(INSPECTOR_TABS).toEqual([
      { id: 'script', label: 'Kịch bản' },
      { id: 'characters', label: 'Nhân vật' },
      { id: 'voice', label: 'Giọng nói' },
      { id: 'ai', label: 'AI' },
    ]);
  });

  it('renders all four tabs with accessible tab semantics', () => {
    const html = renderToStaticMarkup(
      <ScriptInspector segment={segment} speakers={speakers} lipSyncEnabled={false} dispatch={() => {}} />,
    );
    expect(html).toContain('role="tablist"');
    for (const label of ['Kịch bản', 'Nhân vật', 'Giọng nói', 'AI']) {
      expect(html).toMatch(new RegExp(`<button[^>]*role="tab"[^>]*>${label}</button>`));
    }
    expect((html.match(/role="tabpanel"/g) ?? []).length).toBe(4);
  });
});
