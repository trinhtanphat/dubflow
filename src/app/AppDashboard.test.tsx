import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('dashboard-first YupVox app entry', () => {
  it('renders the project dashboard as the initial application view', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('project-dashboard');
    expect(html).toContain('Dự án dubbing');
    expect(html).toContain('Đang tải dự án');
    expect(html).not.toContain('studio-pro-shell');
  });
});
