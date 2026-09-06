import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHARE_TTL_SECONDS,
  SHARE_TTL_OPTIONS,
  SharePanelView,
} from './SharePanel';

describe('SharePanel expiry controls', () => {
  it('defaults to seven days and offers only the approved bounded TTL choices', () => {
    expect(DEFAULT_SHARE_TTL_SECONDS).toBe(604800);
    expect(SHARE_TTL_OPTIONS).toEqual([
      { seconds: 3600, label: '1 giờ' },
      { seconds: 86400, label: '24 giờ' },
      { seconds: 604800, label: '7 ngày' },
      { seconds: 2592000, label: '30 ngày' },
    ]);

    const html = renderToStaticMarkup(
      <SharePanelView
        shares={[]}
        createdShareUrl=""
        loading={false}
        busy={false}
        error=""
        expiresInSeconds={DEFAULT_SHARE_TTL_SECONDS}
        onExpiresInSecondsChange={() => {}}
        onCreate={() => {}}
        onCopy={() => {}}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('Thời hạn liên kết');
    for (const option of SHARE_TTL_OPTIONS) {
      expect(html).toContain(`value="${option.seconds}"`);
      expect(html).toContain(option.label);
    }
    expect(html).toContain('value="604800" selected=""');
  });
});
