import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsageSummaryPanel } from './UsageSummaryPanel';
import type { UsageSummaryResponse } from './usageApi';

const summary: UsageSummaryResponse = {
  creditBalance: 50000,
  totals: {
    asrAudioSeconds: 90,
    translationCharacters: 1200,
    ttsAudioSeconds: 35.5,
    renderSeconds: 150,
  },
  providers: {
    'deepgram-nova-3': {
      asrAudioSeconds: 90,
      translationCharacters: 0,
      ttsAudioSeconds: 0,
      renderSeconds: 0,
    },
    elevenlabs: {
      asrAudioSeconds: 0,
      translationCharacters: 0,
      ttsAudioSeconds: 35.5,
      renderSeconds: 0,
    },
  },
};

describe('UsageSummaryPanel', () => {
  it('renders informational credits, usage times and provider breakdown', () => {
    const html = renderToStaticMarkup(<UsageSummaryPanel summary={summary} loading={false} error="" />);
    expect(html).toContain('50.000');
    expect(html).toContain('1,5 phút');
    expect(html).toContain('1.200');
    expect(html).toContain('35,5 giây');
    expect(html).toContain('2,5 phút');
    expect(html).toContain('deepgram-nova-3');
    expect(html).toContain('elevenlabs');
    expect(html).not.toMatch(/USD|\$|Thanh toán|Nâng cấp/);
  });

  it('keeps loading and usage errors isolated inside the panel', () => {
    const loading = renderToStaticMarkup(<UsageSummaryPanel summary={null} loading error="" />);
    expect(loading).toContain('Đang tải mức sử dụng');

    const failed = renderToStaticMarkup(<UsageSummaryPanel summary={null} loading={false} error="Không thể tải mức sử dụng." />);
    expect(failed).toContain('Không thể tải mức sử dụng.');
  });
});
