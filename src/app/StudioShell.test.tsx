import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('StudioShell mobile controls', () => {
  it('exposes accessible source and inspector panel controls', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('aria-label="Mở nguồn media"');
    expect(html).toContain('aria-label="Mở inspector"');
  });

  it('restores the reference capability footer without overstating guarded features', () => {
    const html = renderToStaticMarkup(<App />);
    for (const label of [
      'Dub mọi ngôn ngữ',
      'Tự nhận diện nhân vật',
      'Voice preservation',
      'Chạy trên Cloud 24/7',
      'AI voices',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('reference-feature-strip');
    expect((html.match(/Capability-gated/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
