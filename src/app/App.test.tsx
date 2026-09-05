import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('DubFlow studio shell', () => {
  it('renders the core dubbing workspace', () => {
    const html = renderToStaticMarkup(<App />);
    for (const label of ['DubFlow','Tải lên video','Nhân vật đã nhận diện','Ngôn ngữ gốc','Tiếng Việt','AI Dubbing Studio','Kịch bản','Đồng bộ khẩu hình','Timeline']) expect(html).toContain(label);
    expect(html).toContain('studio-pro-shell');
  });
});
