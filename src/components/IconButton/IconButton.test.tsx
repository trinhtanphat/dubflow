import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('always exposes an accessible label and safe button type', () => {
    const html = renderToStaticMarkup(<IconButton label="Undo" icon="↶" />);
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('title="Undo"');
    expect(html).toContain('type="button"');
  });
});
