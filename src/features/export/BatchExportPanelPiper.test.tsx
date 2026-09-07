import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BatchExportPanelView, dubbedAvailability } from './BatchExportPanel';
import type { ClientVoicePreloadState } from '../voice/clientVoicePreload';

const serverUnavailable = {
  configured: false,
  languages: 'unknown' as const,
  cloning: false,
  preview: false,
  cloneEnrollment: { provider: 'elevenlabs' as const, mode: 'ivc' as const, available: false },
};

const exportCapabilities = {
  duckOriginal: true,
  separation: {
    configured: false,
    provider: null,
    backgroundStem: false,
    dialogueStem: false,
    qualification: 'unavailable' as const,
  },
  visualLipSync: {
    available: false,
    provider: null,
    qualification: 'unavailable' as const,
  },
};

function render(state: ClientVoicePreloadState, localVietnameseSupported = true) {
  return renderToStaticMarkup(
    <BatchExportPanelView
      currentTargetLanguage="vi"
      enabledLanguages={['vi']}
      selectedLanguages={['vi']}
      output="dubbed"
      audioMode="dubbed_only"
      exportCapabilities={exportCapabilities}
      voiceCapabilities={serverUnavailable}
      clientVoicePreloadState={state}
      localVietnameseSupported={localVietnameseSupported}
      busy={state.phase === 'loading_model' || state.phase === 'synthesizing' || state.phase === 'uploading' || state.phase === 'verifying'}
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

describe('local Vietnamese Piper export admission', () => {
  it('allows vi with local Piper even when server TTS is unconfigured', () => {
    expect(dubbedAvailability(serverUnavailable, 'vi', true)).toEqual({ allowed: true, reason: '' });
    const html = render({ phase: 'idle' });
    expect(html).not.toContain('Trình duyệt này chưa hỗ trợ giọng Việt cục bộ.');
    expect(html).not.toMatch(/data-testid="export-current-language" disabled/);
  });

  it('fails vi closed when the browser cannot run the local lane', () => {
    const admission = dubbedAvailability(serverUnavailable, 'vi', false);
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toMatch(/trình duyệt|cục bộ/i);
    expect(render({ phase: 'idle' }, false)).toContain('Trình duyệt này chưa hỗ trợ giọng Việt cục bộ.');
  });

  it('keeps non-vi server provider admission unchanged', () => {
    expect(dubbedAvailability(serverUnavailable, 'ja', true).allowed).toBe(false);
    expect(dubbedAvailability({ ...serverUnavailable, configured: true, languages: ['ja'] }, 'ja', false).allowed).toBe(true);
  });

  it('renders compact preload progress and disables export while active', () => {
    expect(render({ phase: 'loading_model', percent: 42 })).toContain('Đang tải giọng Việt cục bộ: 42%');
    expect(render({ phase: 'synthesizing', completed: 2, total: 8, segmentId: 's3' })).toContain('Đang chuẩn bị giọng Việt 3/8');
    expect(render({ phase: 'verifying', completed: 8, total: 8 })).toContain('Đang xác minh voice cache 8/8');
    expect(render({ phase: 'ready', total: 8 })).toContain('Giọng Việt cục bộ đã sẵn sàng.');
    expect(render({ phase: 'uploading', completed: 0, total: 2, segmentId: 's1' })).toMatch(/data-testid="export-current-language" disabled/);
  });

  it('does not expose an implicit paid fallback action', () => {
    const html = render({ phase: 'failed', message: 'model unavailable' });
    expect(html).not.toMatch(/Grok|ElevenLabs|nạp|top-up|paid/i);
  });
});
