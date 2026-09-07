import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BatchExportPanelView } from './BatchExportPanel';

const voiceCapabilities = {
  configured: true,
  languages: ['vi'] as const,
  cloning: true,
  preview: true,
  cloneEnrollment: { provider: 'elevenlabs' as const, mode: 'ivc' as const, available: true },
};

const unavailable = {
  duckOriginal: true,
  separation: {
    configured: false,
    provider: null,
    backgroundStem: false,
    dialogueStem: false,
    qualification: 'unavailable' as const,
  },
  visualLipSync: { available: false, provider: null },
};

const available = {
  ...unavailable,
  visualLipSync: { available: true, provider: 'sync-labs' },
};

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    projectId: 'project/1',
    currentTargetLanguage: 'vi',
    enabledLanguages: ['vi'],
    selectedLanguages: ['vi'],
    output: 'dubbed',
    audioMode: 'dubbed_only',
    visualMode: 'standard',
    exportCapabilities: unavailable,
    voiceCapabilities,
    busy: false,
    results: [],
    attempts: {},
    error: '',
    onOutputChange: vi.fn(),
    onAudioModeChange: vi.fn(),
    onVisualModeChange: vi.fn(),
    onToggleLanguage: vi.fn(),
    onExportCurrent: vi.fn(),
    onBatchExport: vi.fn(),
    onRetryFailed: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof BatchExportPanelView>[0];
  return renderToStaticMarkup(<BatchExportPanelView {...props} />);
}

describe('Phase 4E Studio visual mode UX', () => {
  it('shows Standard dubbed video and fail-closed Visual lip-sync controls', () => {
    const html = render();
    expect(html).toContain('aria-label="Xử lý hình ảnh"');
    expect(html).toContain('Standard dubbed video');
    expect(html).toMatch(/<option value="lip_sync" disabled="">Visual lip-sync<\/option>/);
    expect(html).toMatch(/lip-sync.*chưa khả dụng|unavailable/i);
  });

  it('enables Visual lip-sync only when capability is available', () => {
    const html = render({ visualMode: 'lip_sync', exportCapabilities: available });
    expect(html).toContain('value="lip_sync" selected=""');
    expect(html).not.toMatch(/<option value="lip_sync"[^>]*disabled/);
  });

  it('renders queued, processing and completed visual states without claiming completion early', () => {
    const base = {
      targetLanguage: 'vi', output: 'dubbed', exportId: 'e1', jobId: 'j1', status: 'queued', visualMode: 'lip_sync',
    };
    const queued = render({
      visualMode: 'lip_sync', exportCapabilities: available, results: [base],
      attempts: { vi: { lipSyncStatus: 'queued', exportObjectKey: null, lipSyncObjectKey: null } },
    });
    expect(queued).toContain('Lip-sync đã xếp hàng');
    expect(queued).not.toContain('Lip-sync hoàn tất');

    const processing = render({
      visualMode: 'lip_sync', exportCapabilities: available, results: [base],
      attempts: { vi: { lipSyncStatus: 'processing', exportObjectKey: 'projects/project/1/exports/vi/e1.mp4', lipSyncObjectKey: null } },
    });
    expect(processing).toContain('Đang xử lý lip-sync');
    expect(processing).not.toContain('Lip-sync hoàn tất');

    const completed = render({
      visualMode: 'lip_sync', exportCapabilities: available, results: [base],
      attempts: { vi: { lipSyncStatus: 'completed', exportObjectKey: 'projects/project/1/exports/vi/e1.mp4', lipSyncObjectKey: 'projects/project/1/exports/vi/e1.lipsync.mp4' } },
    });
    expect(completed).toContain('Lip-sync hoàn tất');
  });

  it('keeps the standard dubbed download visible when lip-sync fails and exposes retry', () => {
    const html = render({
      visualMode: 'lip_sync',
      exportCapabilities: available,
      results: [{ targetLanguage: 'vi', output: 'dubbed', exportId: 'e1', jobId: 'j1', status: 'queued', visualMode: 'lip_sync' }],
      attempts: {
        vi: {
          lipSyncStatus: 'failed',
          exportObjectKey: 'projects/project/1/exports/vi/e1.mp4',
          lipSyncObjectKey: null,
        },
      },
    });
    expect(html).toContain('Lip-sync thất bại');
    expect(html).toContain('Thử lại lip-sync');
    expect(html).toContain('Tải video dubbed chuẩn');
    expect(html).toContain('/api/projects/project%2F1/exports/vi/media?output=dubbed');
  });
});