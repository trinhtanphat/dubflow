import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BatchExportPanelView,
  dubbedAvailability,
} from './BatchExportPanel';

const enabledLanguages = ['vi', 'ja', 'ko'] as const;

const partial = [
  {
    targetLanguage: 'vi' as const,
    output: 'dubbed' as const,
    exportId: 'e-vi',
    jobId: 'j-vi',
    workflowId: 'w-vi',
    status: 'queued' as const,
  },
  {
    targetLanguage: 'ja' as const,
    output: 'dubbed' as const,
    exportId: 'e-ja',
    jobId: 'j-ja',
    status: 'failed' as const,
    code: 'EXPORT_WORKFLOW_START_FAILED',
    message: 'down',
  },
];

describe('Phase 4C batch export studio controls', () => {
  it('keeps partial batch results and exposes retry only for failed targets', () => {
    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        enabledLanguages={[...enabledLanguages]}
        selectedLanguages={['vi', 'ja']}
        output="dubbed"
        voiceCapabilities={{
          configured: true,
          languages: ['vi', 'ja'],
          cloning: true,
          preview: true,
          cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
        }}
        busy={false}
        results={partial}
        error=""
        onOutputChange={vi.fn()}
        onToggleLanguage={vi.fn()}
        onExportCurrent={vi.fn()}
        onBatchExport={vi.fn()}
        onRetryFailed={vi.fn()}
      />,
    );

    expect(html).toContain('Export current language');
    expect(html).toContain('Batch export selected languages');
    expect(html).toContain('Tiếng Việt');
    expect(html).toContain('日本語');
    expect(html).toContain('Đã xếp hàng');
    expect(html).toContain('Thất bại');
    expect((html.match(/Thử lại/g) ?? []).length).toBe(1);
    expect(html).not.toContain('Tất cả ngôn ngữ đã xuất thành công');
  });

  it('fails dubbed output closed for unsupported or unknown language capability while subtitles remain available', () => {
    const unsupported = dubbedAvailability({
      configured: true,
      languages: ['vi'],
      cloning: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
    }, 'ja');
    const unknown = dubbedAvailability({
      configured: true,
      languages: 'unknown',
      cloning: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
    }, 'ja');

    expect(unsupported.allowed).toBe(false);
    expect(unsupported.reason).toMatch(/không hỗ trợ|unsupported/i);
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toMatch(/chưa xác nhận|unknown|unqualified/i);

    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        enabledLanguages={['ja']}
        selectedLanguages={['ja']}
        output="subtitles"
        voiceCapabilities={{
          configured: false,
          languages: 'unknown',
          cloning: false,
          cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
        }}
        busy={false}
        results={[]}
        error=""
        onOutputChange={vi.fn()}
        onToggleLanguage={vi.fn()}
        onExportCurrent={vi.fn()}
        onBatchExport={vi.fn()}
        onRetryFailed={vi.fn()}
      />,
    );
    expect(html).toContain('value="subtitles" selected=""');
    expect(html).not.toContain('disabled="" data-testid="export-current-language"');
  });
});
