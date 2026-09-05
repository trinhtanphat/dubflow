import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ScriptInspector } from './ScriptInspector';

const segment = { id: 's1', speakerId: 'speaker-1', startMs: 0, endMs: 1000, sourceText: '你好', translatedText: 'Xin chào' };
const speakers = [{ id: 'speaker-1', name: 'Nữ chính', label: 'Nhân vật', share: 100 }];

describe('ScriptInspector cloud editor controls', () => {
  it('renders provider selection, retranslation and compare choices for a cloud segment', () => {
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
    for (const label of ['Dịch lại','Workers AI','Google','So sánh','Bản AI','Bản Google','Áp dụng']) expect(html).toContain(label);
  });
});
