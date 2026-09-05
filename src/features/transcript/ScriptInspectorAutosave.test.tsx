import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { editDraft, failDraftSave, conflictDraftSave } from '../../app/autosaveDraft';
import { ScriptInspector } from './ScriptInspector';

const segment = {
  id: 'seg-1', speakerId: 'speaker-1', startMs: 1000, endMs: 3000,
  sourceText: 'server source', translatedText: 'server translation', version: 3,
};
const speakers = [{ id: 'speaker-1', name: 'Nhân vật 1', label: 'Nữ chính', share: 1 }];

const common = {
  segment,
  speakers,
  lipSyncEnabled: true,
  dispatch: vi.fn(),
  cloudEditable: true,
  onEditDraft: vi.fn(),
  onFlushDraft: vi.fn(),
  onRetryDraft: vi.fn(),
  onDiscardConflict: vi.fn(),
  onReapplyConflict: vi.fn(),
};

describe('ScriptInspector autosave UI', () => {
  it('renders local draft values instead of mutating canonical display data', () => {
    const draft = editDraft(undefined, segment, {
      sourceText: 'local source',
      translatedText: 'local translation',
    });
    const html = renderToStaticMarkup(<ScriptInspector {...common} draft={draft} />);
    expect(html).toContain('local source');
    expect(html).toContain('local translation');
    expect(html).not.toContain('>server source</textarea>');
    expect(html).not.toContain('>server translation</textarea>');
  });

  it('shows an explicit retry action for a non-conflict save error', () => {
    const draft = failDraftSave(editDraft(undefined, segment, { translatedText: 'local' }), 'network down');
    const html = renderToStaticMarkup(<ScriptInspector {...common} draft={draft} />);
    expect(html).toContain('network down');
    expect(html).toContain('Thử lưu lại');
    expect(html).not.toContain('Dùng bản mới trên server');
  });

  it('renders policy-A conflict UI without losing voice preview capability', () => {
    const saving = editDraft(undefined, segment, { translatedText: 'mine' });
    const draft = conflictDraftSave(saving, { ...segment, translatedText: 'server-new', version: 7 });
    const html = renderToStaticMarkup(
      <ScriptInspector
        {...common}
        draft={draft}
        voiceConfigured
        voiceProviderLabel="ElevenLabs"
        onPreviewVoice={vi.fn()}
      />,
    );
    expect(html).toContain('Dùng bản mới trên server');
    expect(html).toContain('Áp dụng lại thay đổi của tôi');
    expect(html).toContain('▷ Nghe thử giọng · ElevenLabs');
  });
});
