import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BatchExportPanelView, visualLipSyncAvailability } from './BatchExportPanel';
import type { ExportCapabilitiesDto, ExportLaunchDto } from './batchExportApi';

const voiceCapabilities = {
  configured: true,
  languages: ['ja'] as ['ja'],
  cloning: true,
  preview: true,
  cloneEnrollment: { provider: 'elevenlabs' as const, mode: 'ivc' as const, available: true },
};

type VisualQualification = 'qualified' | 'unqualified' | 'unavailable';

function capabilities(
  available: boolean,
  qualification: VisualQualification = available ? 'qualified' : 'unavailable',
): ExportCapabilitiesDto {
  return {
    duckOriginal: true,
    separation: {
      configured: false,
      provider: null,
      backgroundStem: false,
      dialogueStem: false,
      qualification: 'unavailable',
    },
    visualLipSync: {
      available,
      provider: qualification === 'unavailable' ? null : 'sync-labs',
      qualification,
    },
  } as unknown as ExportCapabilitiesDto;
}

function result(
  lipSyncStatus: 'queued' | 'processing' | 'failed' | 'completed',
): ExportLaunchDto {
  return {
    targetLanguage: 'ja',
    output: 'dubbed',
    exportId: `e-${lipSyncStatus}`,
    jobId: `j-${lipSyncStatus}`,
    status: lipSyncStatus === 'completed' ? 'completed' : lipSyncStatus === 'failed' ? 'failed' : 'processing',
    audioMode: 'dubbed_only',
    visualMode: 'lip_sync',
    lipSyncRequested: true,
    lipSyncStatus,
    exportObjectKey: `projects/p1/exports/ja/e-${lipSyncStatus}.mp4`,
    lipSyncObjectKey: lipSyncStatus === 'completed'
      ? `projects/p1/exports/ja/e-${lipSyncStatus}.lipsync.mp4`
      : null,
  };
}

function render(options: {
  available?: boolean;
  qualification?: VisualQualification;
  visualMode?: 'standard' | 'lip_sync';
  results?: ExportLaunchDto[];
} = {}) {
  return renderToStaticMarkup(
    <BatchExportPanelView
      projectId="p1"
      currentTargetLanguage="ja"
      enabledLanguages={['ja']}
      selectedLanguages={['ja']}
      output="dubbed"
      audioMode="dubbed_only"
      visualMode={options.visualMode ?? 'standard'}
      exportCapabilities={capabilities(options.available ?? false, options.qualification)}
      voiceCapabilities={voiceCapabilities}
      busy={false}
      results={options.results ?? []}
      error=""
      onOutputChange={vi.fn()}
      onAudioModeChange={vi.fn()}
      onVisualModeChange={vi.fn()}
      onToggleLanguage={vi.fn()}
      onExportCurrent={vi.fn()}
      onBatchExport={vi.fn()}
      onRetryFailed={vi.fn()}
    />,
  );
}

describe('Phase 4E Studio visual-mode UX', () => {
  it('fails closed when the backend has no configured visual provider', () => {
    expect(visualLipSyncAvailability(capabilities(false, 'unavailable'))).toEqual({
      allowed: false,
      reason: 'Visual lip-sync chưa khả dụng vì provider chưa được cấu hình.',
    });

    const html = render({ available: false, qualification: 'unavailable', visualMode: 'lip_sync' });
    expect(html).toContain('Standard dubbed video');
    expect(html).toContain('Visual lip-sync');
    expect(html).toMatch(/<option value="lip_sync" disabled=""[^>]*>Visual lip-sync<\/option>/);
    expect(html).toContain('Visual lip-sync chưa khả dụng vì provider chưa được cấu hình.');
    expect(html).toMatch(/<button[^>]*data-testid="export-current-language"[^>]*disabled=""/);
  });

  it('fails closed when Sync is configured but runtime qualification is still unqualified', () => {
    expect(visualLipSyncAvailability(capabilities(false, 'unqualified'))).toEqual({
      allowed: false,
      reason: 'Visual lip-sync đã cấu hình nhưng runtime chưa được xác nhận (unqualified).',
    });

    const html = render({ available: false, qualification: 'unqualified', visualMode: 'lip_sync' });
    expect(html).toMatch(/<option value="lip_sync" disabled=""[^>]*>Visual lip-sync<\/option>/);
    expect(html).toContain('Visual lip-sync đã cấu hình nhưng runtime chưa được xác nhận (unqualified).');
    expect(html).toMatch(/<button[^>]*data-testid="export-current-language"[^>]*disabled=""/);
  });

  it('enables the visual choice only with an available named qualified provider', () => {
    expect(visualLipSyncAvailability(capabilities(true, 'qualified'))).toEqual({ allowed: true, reason: '' });
    const html = render({ available: true, qualification: 'qualified', visualMode: 'lip_sync' });
    expect(html).toContain('value="lip_sync" selected=""');
    expect(html).not.toMatch(/<option value="lip_sync"[^>]*disabled/);
    expect(html).not.toMatch(/data-testid="export-current-language"[^>]*disabled/);
  });

  it('renders queued, processing, failed, and completed visual states without claiming completion early', () => {
    const html = render({
      available: true,
      qualification: 'qualified',
      visualMode: 'lip_sync',
      results: [result('queued'), result('processing'), result('failed'), result('completed')],
    });

    expect(html).toContain('Lip-sync đã xếp hàng');
    expect(html).toContain('Đang xử lý lip-sync');
    expect(html).toContain('Lip-sync thất bại');
    expect(html).toContain('Lip-sync hoàn tất');
    expect((html.match(/Lip-sync hoàn tất/g) ?? []).length).toBe(1);
  });

  it('keeps the normal dubbed artifact downloadable and retryable when visual processing fails', () => {
    const html = render({ available: true, qualification: 'qualified', visualMode: 'lip_sync', results: [result('failed')] });
    expect(html).toContain('Thử lại lip-sync');
    expect(html).toContain('Tải video dubbed chuẩn');
    expect(html).toContain('/api/projects/p1/exports/ja/media?output=dubbed');
    expect(html).not.toContain('.lipsync.mp4');
  });

  it('publishes the owner visual download only after lip-sync completion without presenting the standard fallback', () => {
    const html = render({ available: true, qualification: 'qualified', visualMode: 'lip_sync', results: [result('completed')] });
    expect(html).toContain('Lip-sync hoàn tất');
    expect(html).toContain('Tải video lip-sync');
    expect(html).toContain('/api/projects/p1/exports/ja/media?output=dubbed&amp;visualMode=lip_sync');
    expect(html).not.toContain('Thử lại lip-sync');
    expect(html).not.toContain('Tải video dubbed chuẩn');
  });
});
