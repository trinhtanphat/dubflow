import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  MultiLanguageExportPanelView,
  latestExportVariants,
  toggleTargetSelection,
} from './MultiLanguageExportPanel';
import type { ExportVariant, TargetLanguage } from './multilangExportApi';

function variant(overrides: Partial<ExportVariant>): ExportVariant {
  return {
    id: 'exp-1', projectId: 'p1', batchId: 'batch-1', targetLanguage: 'vi',
    status: 'queued', objectKey: null, jobId: 'job-1', errorCode: null, generation: 0,
    ...overrides,
  };
}

describe('Phase 4C multilingual export panel', () => {
  it('keeps selection bounded to one through four canonical targets', () => {
    expect(toggleTargetSelection(['vi'], 'vi')).toEqual(['vi']);
    expect(toggleTargetSelection(['vi'], 'ja')).toEqual(['vi', 'ja']);
    expect(toggleTargetSelection(['vi', 'ja'], 'vi')).toEqual(['ja']);

    const four: TargetLanguage[] = ['vi', 'en', 'ja', 'ko'];
    expect(toggleTargetSelection(four, 'zh')).toEqual(four);
  });

  it('keeps only the newest variant per target from a newest-first export list', () => {
    const newestJa = variant({ id: 'ja-new', targetLanguage: 'ja', status: 'completed' });
    const oldJa = variant({ id: 'ja-old', targetLanguage: 'ja', status: 'failed' });
    const en = variant({ id: 'en-1', targetLanguage: 'en', status: 'running' });
    expect(latestExportVariants([newestJa, oldJa, en])).toEqual([newestJa, en]);
  });

  it('renders all five targets, independent partial-success states, download and share actions', () => {
    const html = renderToStaticMarkup(
      <MultiLanguageExportPanelView
        projectId="p1"
        selectedTargets={['vi', 'ja']}
        variants={[
          variant({ id: 'ja-ok', targetLanguage: 'ja', status: 'completed', objectKey: 'projects/p1/exports/ja/ja-ok.mp4' }),
          variant({ id: 'en-fail', targetLanguage: 'en', status: 'failed', errorCode: 'EXPORT_PROVIDER_FAILED' }),
        ]}
        loading={false}
        busy={false}
        error=""
        onToggle={vi.fn()}
        onSave={vi.fn()}
        onStartBatch={vi.fn()}
        onRefresh={vi.fn()}
        onShareVariant={vi.fn()}
      />,
    );

    for (const code of ['VI', 'EN', 'JA', 'KO', 'ZH']) expect(html).toContain(code);
    expect(html).toContain('Chọn 1–4 ngôn ngữ');
    expect(html).toContain('Hoàn tất');
    expect(html).toContain('Lỗi');
    expect(html).toContain('/api/projects/p1/exports/ja-ok/media');
    expect(html).toContain('Tải MP4');
    expect(html).toContain('Chia sẻ');
    expect(html).toContain('EXPORT_PROVIDER_FAILED');
  });
});
