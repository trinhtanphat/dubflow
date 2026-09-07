import type { ComponentProps } from 'react';
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

function baseProps(): ComponentProps<typeof BatchExportPanelView> {
  return {
    currentTargetLanguage: 'ja',
    enabledLanguages: [...enabledLanguages],
    selectedLanguages: ['vi', 'ja'],
    output: 'dubbed',
    voiceCapabilities: {
      configured: true,
      languages: ['vi', 'ja'],
      cloning: true,
      preview: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
    },
    busy: false,
    results: partial,
    error: '',
    onOutputChange: vi.fn(),
    onToggleLanguage: vi.fn(),
    onExportCurrent: vi.fn(),
    onBatchExport: vi.fn(),
    onRetryFailed: vi.fn(),
  };
}

describe('Phase 4C batch export studio controls', () => {
  it('keeps partial batch results and exposes retry only for failed targets', () => {
    const html = renderToStaticMarkup(<BatchExportPanelView {...baseProps()} />);

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
      preview: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
    }, 'ja');
    const unknown = dubbedAvailability({
      configured: true,
      languages: 'unknown',
      cloning: true,
      preview: true,
      cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: true },
    }, 'ja');

    expect(unsupported.allowed).toBe(false);
    expect(unsupported.reason).toMatch(/không hỗ trợ|unsupported/i);
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toMatch(/chưa xác nhận|unknown|unqualified/i);

    const html = renderToStaticMarkup(
      <BatchExportPanelView
        {...baseProps()}
        enabledLanguages={['ja']}
        selectedLanguages={['ja']}
        output="subtitles"
        voiceCapabilities={{
          configured: false,
          languages: 'unknown',
          cloning: false,
          preview: false,
          cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
        }}
        results={[]}
      />,
    );
    expect(html).toContain('value="subtitles" selected=""');
    expect(html).not.toContain('disabled="" data-testid="export-current-language"');
  });

  it('shows explicit background preparation controls without starting expensive work implicitly', () => {
    const html = renderToStaticMarkup(<BatchExportPanelView {...baseProps()} />);

    expect(html).toContain('Dubbed voices only');
    expect(html).toContain('Preserve music &amp; ambience');
    expect(html).toContain('Prepare background');
    expect(html).toContain('Not prepared');
    expect(html).toContain('Unqualified');
  });

  it('allows preserve mode only for a qualified completed separation', () => {
    const html = renderToStaticMarkup(
      <BatchExportPanelView
        {...baseProps()}
        mixMode="preserve_background"
        separationState={{
          status: 'completed',
          qualified: true,
          separation: {
            id: 'sep-1',
            status: 'completed',
            sourceRevision: 2,
            provider: 'demucs',
            modelId: 'htdemucs',
            jobId: 'job-sep',
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-09-07T00:00:00Z',
            completedAt: '2026-09-07T00:01:00Z',
          },
        }}
        separationBusy={false}
        separationError=""
        onMixModeChange={vi.fn()}
        onPrepareBackground={vi.fn()}
      />,
    );

    expect(html).toContain('Ready');
    expect(html).toMatch(/<input(?=[^>]*value="preserve_background")(?=[^>]*checked="")[^>]*>/);
    expect(html).not.toContain('Unqualified');
  });
});