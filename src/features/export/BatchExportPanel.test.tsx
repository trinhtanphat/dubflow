import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BatchExportPanelView, retryableFailedTargets } from './BatchExportPanel';

const results = [
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

describe('Phase 4C batch export panel', () => {
  it('keeps partial success visible and exposes retry only for failed targets', () => {
    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        selectedTargetLanguages={['vi', 'ja']}
        output="dubbed"
        results={results}
        busy={false}
        error=""
        dubbedAvailability={{ available: true, reason: '' }}
        onOutputChange={vi.fn()}
        onToggleTarget={vi.fn()}
        onExportCurrent={vi.fn()}
        onBatchExport={vi.fn()}
        onRetryTarget={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="batch-export-panel"');
    expect(html).toContain('Export current language');
    expect(html).toContain('Batch export selected languages');
    expect(html).toContain('vi');
    expect(html).toContain('ja');
    expect(html).toContain('Đã xếp hàng');
    expect(html).toContain('Thất bại');
    expect((html.match(/Retry ja/g) ?? []).length).toBe(1);
    expect(html).not.toContain('Retry vi');
    expect(retryableFailedTargets(results)).toEqual(['ja']);
  });

  it('disables dubbed with an explicit capability reason while subtitles remain available', () => {
    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        selectedTargetLanguages={['ja']}
        output="subtitles"
        results={[]}
        busy={false}
        error=""
        dubbedAvailability={{ available: false, reason: 'Voice capability cho 日本語 chưa được xác nhận.' }}
        onOutputChange={vi.fn()}
        onToggleTarget={vi.fn()}
        onExportCurrent={vi.fn()}
        onBatchExport={vi.fn()}
        onRetryTarget={vi.fn()}
      />,
    );

    expect(html).toContain('Voice capability cho 日本語 chưa được xác nhận.');
    expect(html).toContain('Subtitles');
    expect(html).toContain('Dubbed');
    expect(html).toMatch(/value="dubbed"[^>]*disabled/);
    expect(html).toMatch(/value="subtitles"/);
  });
});
