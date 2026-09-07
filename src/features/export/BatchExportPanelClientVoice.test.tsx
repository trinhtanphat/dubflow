import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BatchExportPanelView, dubbedAvailability } from './BatchExportPanel';

const unconfigured = {
  configured: false,
  languages: 'unknown' as const,
  cloning: false,
  preview: false,
  cloneEnrollment: { provider: 'elevenlabs' as const, mode: 'ivc' as const, available: false },
};

const configured = {
  configured: true,
  languages: ['vi', 'en'] as const,
  cloning: false,
  preview: false,
  cloneEnrollment: { provider: 'elevenlabs' as const, mode: 'ivc' as const, available: false },
};

function render({
  current = 'vi' as ('vi' | 'en'),
  selected = ['vi'] as ('vi' | 'en')[],
  clientVoiceAvailable = false,
  clientVoiceStatus = '',
} = {}) {
  return renderToStaticMarkup(
    <BatchExportPanelView
      currentTargetLanguage={current}
      enabledLanguages={selected}
      selectedLanguages={selected}
      output="dubbed"
      audioMode="dubbed_only"
      exportCapabilities={null}
      voiceCapabilities={unconfigured}
      clientVoiceAvailable={clientVoiceAvailable}
      clientVoiceStatus={clientVoiceStatus}
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
}

describe('Vietnamese browser client voice admission', () => {
  it('allows vi when the server provider is unconfigured but the client lane is available', () => {
    expect(dubbedAvailability(unconfigured, 'vi', true)).toEqual({ allowed: true, reason: '' });
    const html = render({ clientVoiceAvailable: true });
    expect(html).toMatch(/data-testid="export-current-language"(?![^>]*disabled)/);
  });

  it('does not broaden the client lane to non-Vietnamese targets', () => {
    expect(dubbedAvailability(unconfigured, 'en', true).allowed).toBe(false);
    const html = render({ current: 'en', selected: ['en'], clientVoiceAvailable: true });
    expect(html).toMatch(/data-testid="export-current-language"[^>]*disabled/);
  });

  it('keeps vi blocked when both server and client voice are unavailable', () => {
    expect(dubbedAvailability(unconfigured, 'vi', false).allowed).toBe(false);
    const html = render();
    expect(html).toMatch(/data-testid="export-current-language"[^>]*disabled/);
  });

  it('does not admit vi through a configured server provider when the zero-cost client lane is unavailable', () => {
    expect(dubbedAvailability(configured, 'vi', false)).toEqual({
      allowed: false,
      reason: 'Giọng Việt cục bộ chưa khả dụng trong trình duyệt này.',
    });
  });

  it('still blocks a mixed batch when a selected non-vi target lacks server capability', () => {
    const html = render({ selected: ['vi', 'en'], clientVoiceAvailable: true });
    expect(html).toMatch(/<button type="button" class="primary-button" disabled=""/);
  });

  it('renders one preparation status line when provided', () => {
    const html = render({ clientVoiceAvailable: true, clientVoiceStatus: 'Đang tạo giọng 1/2' });
    expect(html).toContain('Đang tạo giọng 1/2');
  });
});
