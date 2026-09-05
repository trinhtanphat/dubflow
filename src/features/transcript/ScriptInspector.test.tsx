import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ScriptInspector } from './ScriptInspector';

const segment = {
  id: 'seg-1',
  speakerId: 'speaker-1',
  startMs: 1000,
  endMs: 3000,
  sourceText: '你好',
  translatedText: 'Xin chào',
};

const speakers = [{ id: 'speaker-1', name: 'Nhân vật 1', label: 'Nữ chính', share: 1 }];

describe('ScriptInspector', () => {
  it('exposes the Characters tab but keeps voice preview fail-closed when no provider is configured', () => {
    const html = renderToStaticMarkup(
      <ScriptInspector segment={segment} speakers={speakers} lipSyncEnabled={false} dispatch={() => {}} />,
    );
    expect(html).toContain('Kịch bản');
    expect(html).toMatch(/<button[^>]*>Nhân vật<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Nhân vật<\/button>/);
    expect(html).toContain('Chưa cấu hình');
    expect(html).not.toContain('Nhà cung cấp dịch');
  });

  it('enables real voice preview when the backend reports ElevenLabs configured', () => {
    const html = renderToStaticMarkup(
      <ScriptInspector
        segment={segment}
        speakers={speakers}
        lipSyncEnabled
        dispatch={vi.fn()}
        cloudEditable
        translationMode="compare"
        onTranslationModeChange={vi.fn()}
        onCommitPatch={vi.fn()}
        onRetranslate={vi.fn()}
        comparison={{ workersAI: 'Bản AI', google: 'Bản Google' }}
        onApplyTranslation={vi.fn()}
        voiceConfigured
        voiceProviderLabel="ElevenLabs"
        onPreviewVoice={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="Nhà cung cấp dịch"');
    for (const label of ['Dịch lại', 'Workers AI', 'Google', 'So sánh', 'Bản AI', 'Bản Google', 'Áp dụng']) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/<button[^>]*>▷ Nghe thử giọng · ElevenLabs<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>▷ Nghe thử giọng · ElevenLabs<\/button>/);
    expect(html).toContain('Tạo lại giọng');
    expect(html).not.toContain('Tạo lại giọng · Chưa cấu hình');
  });

  it('keeps reference-density hooks around the existing persisted editor flow', () => {
    const html = renderToStaticMarkup(
      <ScriptInspector
        segment={segment}
        speakers={speakers}
        lipSyncEnabled
        dispatch={vi.fn()}
        cloudEditable
        translationMode="compare"
        onTranslationModeChange={vi.fn()}
        onCommitPatch={vi.fn()}
        onRetranslate={vi.fn()}
        comparison={{ workersAI: 'Bản AI', google: 'Bản Google' }}
        onApplyTranslation={vi.fn()}
      />,
    );
    expect(html).toContain('reference-inspector-header');
    expect((html.match(/reference-script-card/g) ?? []).length).toBe(2);
    expect(html).toContain('reference-translation-tools');
    expect(html).toContain('reference-voice-assignment');
    expect(html).toContain('aria-label="Lời thoại gốc"');
    expect(html).toContain('aria-label="Lời thoại dubbing tiếng Việt"');
    expect(html).toContain('Gán giọng cho nhân vật');
    expect(html).toContain('Đồng bộ khẩu hình');
  });
});
