import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('StudioShell mobile controls', () => {
  it('exposes accessible source and inspector panel controls', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('aria-label="Mở nguồn media"');
    expect(html).toContain('aria-label="Mở inspector"');
  });
});
