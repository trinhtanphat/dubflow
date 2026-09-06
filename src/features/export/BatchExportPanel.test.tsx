import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  BatchExportPanelView,
  dubbedAvailability,
  separatedBackgroundAvailability,
} from './BatchExportPanel';

const enabledLanguages = ['vi', 'ja', 'ko'] as const;
const unavailableSeparation = {
  duckOriginal: true,
  separation: {
    configured: false,
    provider: null,
    backgroundStem: false,
    dialogueStem: false,
    qualification: 'unavailable' as const,
  },
};
const qualifiedSeparation = {
  duckOriginal: true,
  separation: {
    configured: true,
    provider: 'qualified-provider',
    backgroundStem: true,
    dialogueStem: true,
    qualification: 'qualified' as const,
  },
};

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

const voiceCapabilities = {
  configured: true,
  languages: ['vi', 'ja'] as ('vi' | 'ja')[],
  cloning: true,
  preview: true,
  cloneEnrollment: { provider: 'elevenlabs' as const, mode: 'ivc' as const, available: true },
};

describe('Phase 4D batch export studio controls', () => {
  it('keeps partial batch results and exposes retry only for failed targets', () => {
    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        enabledLanguages={[...enabledLanguages]}
        selectedLanguages={['vi', 'ja']}
        output="dubbed"
        audioMode="dubbed_only"
        exportCapabilities={unavailableSeparation}
        voiceCapabilities={voiceCapabilities}
        busy={false}
        results={partial}
        error=""
        onOutputChange={vi.fn()}
        onAudioModeChange={vi.fn()}
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

  it('shows exact three audio treatment labels and disables only unqualified separated background', () => {
    expect(separatedBackgroundAvailability(unavailableSeparation).allowed).toBe(false);
    expect(separatedBackgroundAvailability(qualifiedSeparation).allowed).toBe(true);

    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        enabledLanguages={['ja']}
        selectedLanguages={['ja']}
        output="dubbed"
        audioMode="duck_original"
        exportCapabilities={unavailableSeparation}
        voiceCapabilities={voiceCapabilities}
        busy={false}
        results={[]}
        error=""
        onOutputChange={vi.fn()}
        onAudioModeChange={vi.fn()}
        onToggleLanguage={vi.fn()}
        onExportCurrent={vi.fn()}
        onBatchExport={vi.fn()}
        onRetryFailed={vi.fn()}
      />,
    );

    expect(html).toContain('Dubbed voice only');
    expect(html).toContain('Keep original ambience (duck dialogue)');
    expect(html).toContain('Separated background stem');
    expect(html).toContain('value="duck_original" selected=""');
    expect(html).toMatch(/<option value="separated_background" disabled="">Separated background stem<\/option>/);
    expect(html).not.toMatch(/<option value="duck_original"[^>]*disabled/);
    expect(html).toMatch(/unavailable|chưa khả dụng|chưa được xác nhận/i);
  });

  it('enables separated background only for a qualified configured background provider', () => {
    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        enabledLanguages={['ja']}
        selectedLanguages={['ja']}
        output="dubbed"
        audioMode="separated_background"
        exportCapabilities={qualifiedSeparation}
        voiceCapabilities={voiceCapabilities}
        busy={false}
        results={[]}
        error=""
        onOutputChange={vi.fn()}
        onAudioModeChange={vi.fn()}
        onToggleLanguage={vi.fn()}
        onExportCurrent={vi.fn()}
        onBatchExport={vi.fn()}
        onRetryFailed={vi.fn()}
      />,
    );
    expect(html).toContain('value="separated_background" selected=""');
    expect(html).not.toMatch(/<option value="separated_background"[^>]*disabled/);
  });

  it('fails dubbed output closed for unsupported or unknown voice capability while subtitles remain available', () => {
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
    expect(unknown.allowed).toBe(false);

    const html = renderToStaticMarkup(
      <BatchExportPanelView
        currentTargetLanguage="ja"
        enabledLanguages={['ja']}
        selectedLanguages={['ja']}
        output="subtitles"
        audioMode="separated_background"
        exportCapabilities={unavailableSeparation}
        voiceCapabilities={{
          configured: false,
          languages: 'unknown',
          cloning: false,
          preview: false,
          cloneEnrollment: { provider: 'elevenlabs', mode: 'ivc', available: false },
        }}
        busy={false}
        results={[]}
        error=""
        onOutputChange={vi.fn()}
        onAudioModeChange={vi.fn()}
        onToggleLanguage={vi.fn()}
        onExportCurrent={vi.fn()}
        onBatchExport={vi.fn()}
        onRetryFailed={vi.fn()}
      />,
    );
    expect(html).toContain('value="subtitles" selected=""');
    expect(html).not.toContain('aria-label="Xử lý âm thanh"');
    expect(html).not.toContain('disabled="" data-testid="export-current-language"');
  });
});
