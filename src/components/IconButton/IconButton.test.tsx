import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('always exposes an accessible label', () => {
    const html = renderToStaticMarkup(<IconButton label="Undo" icon="↶" />);
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('title="Undo"');
  });
});
