import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders label, detail and semantic tone hook', () => {
    const html = renderToStaticMarkup(<StatusBadge label="Saved" tone="success" detail="Cloud synced" />);
    expect(html).toContain('Saved');
    expect(html).toContain('Cloud synced');
    expect(html).toContain('status-badge--success');
  });
});
