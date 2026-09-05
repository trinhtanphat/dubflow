import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('YupVox application shell', () => {
  it('renders the durable project dashboard before opening a studio project', () => {
    const html = renderToStaticMarkup(<App />);
    for (const label of ['YupVox.Com', 'Dự án dubbing', 'Tạo dự án', 'Đang tải dự án']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('project-dashboard');
    expect(html).toContain('aria-label="Bảng dự án YupVox"');
  });

  it('does not render the Studio workspace until a project is opened or created', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).not.toContain('studio-pro-shell');
    expect(html).not.toContain('aria-label="Nguồn media và nhân vật"');
    expect(html).not.toContain('aria-label="Không gian chỉnh sửa"');
    expect(html).not.toContain('aria-label="Inspector dubbing"');
  });
});
