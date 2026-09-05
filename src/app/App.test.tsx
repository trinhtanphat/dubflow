import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('DubFlow studio shell', () => {
  it('renders the core dubbing workspace', () => {
    const html = renderToStaticMarkup(<App />);
    for (const label of ['DubFlow','Tải lên video','Nhân vật đã nhận diện','Ngôn ngữ gốc','Tiếng Việt','AI Dubbing Studio','Kịch bản','Đồng bộ khẩu hình','Timeline']) expect(html).toContain(label);
    expect(html).toContain('studio-pro-shell');
    expect(html).toContain('aria-label="Nguồn media và nhân vật"');
    expect(html).toContain('aria-label="Không gian chỉnh sửa"');
    expect(html).toContain('aria-label="Inspector dubbing"');
  });

  it('integrates the truthful player state with the interactive timeline', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Chưa có media phát được');
    expect(html).not.toContain('aria-label="Video source"');
    expect(html).not.toContain('character--left');
    expect(html).toContain('aria-label="Phóng to timeline"');
    expect(html).toContain('aria-label="Vừa toàn dự án"');
    expect(html).toContain('aria-label="Kéo playhead"');
  });
});
