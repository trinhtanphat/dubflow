import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScriptInspector } from './ScriptInspector';

const segment = {
  id: 'seg-1',
  speakerId: 'speaker-1',
  startMs: 1000,
  endMs: 3000,
  sourceText: '你好',
  translatedText: 'Xin chào',
};

const speakers = [{ id: 'speaker-1', name: 'Nhân vật 1', label: 'Nữ chính', share: 1 }];

describe('ScriptInspector', () => {
  it('does not present the future Characters tab as currently interactive', () => {
    const html = renderToStaticMarkup(
      <ScriptInspector segment={segment} speakers={speakers} lipSyncEnabled={false} dispatch={() => {}} />,
    );
    expect(html).toContain('Kịch bản');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Nhân vật<\/button>/);
    expect(html).toContain('Chưa cấu hình');
  });
});
