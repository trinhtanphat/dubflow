import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Segment } from '../timeline/types';
import { SegmentConflictNotice } from './SegmentConflictNotice';

const local: Segment = {
  id: 's1', speakerId: 'sp1', startMs: 0, endMs: 1000,
  sourceText: 'local source', translatedText: 'bản của tôi', version: 2,
};
const server: Segment = { ...local, sourceText: 'server source', translatedText: 'bản mới server', version: 5 };

describe('SegmentConflictNotice', () => {
  it('shows both canonical server truth and preserved local patch with exactly the two policy-A actions', () => {
    const html = renderToStaticMarkup(
      <SegmentConflictNotice
        local={local}
        server={server}
        touchedFields={['translatedText']}
        onUseServer={vi.fn()}
        onReapply={vi.fn()}
      />,
    );
    expect(html).toContain('Xung đột');
    expect(html).toContain('bản của tôi');
    expect(html).toContain('bản mới server');
    expect(html).toContain('Bản dịch');
    expect(html).toContain('Dùng bản mới trên server');
    expect(html).toContain('Áp dụng lại thay đổi của tôi');
    expect((html.match(/<button/g) ?? []).length).toBe(2);
  });
});
