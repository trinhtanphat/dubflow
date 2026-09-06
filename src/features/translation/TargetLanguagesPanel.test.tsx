import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  LANGUAGE_LABELS,
  TargetLanguagesPanelView,
  recoverProjectLanguagesConflict,
} from './TargetLanguagesPanel';

const config = {
  revision: 7,
  languages: [
    { targetLanguage: 'vi' as const, status: 'ready' as const },
    { targetLanguage: 'ja' as const, status: 'needs_review' as const },
    { targetLanguage: 'ko' as const, status: 'failed' as const },
  ],
};

describe('Phase 4C target language panel', () => {
  it('renders Source plus enabled targets and truthful per-language status chips', () => {
    const html = renderToStaticMarkup(
      <TargetLanguagesPanelView
        config={config}
        currentLanguage="ja"
        saving={false}
        error=""
        conflictMessage=""
        onCurrentLanguageChange={vi.fn()}
        onToggleTarget={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="target-languages-panel"');
    expect(html).toContain('Source');
    expect(html).toContain(LANGUAGE_LABELS.vi);
    expect(html).toContain(LANGUAGE_LABELS.ja);
    expect(html).toContain(LANGUAGE_LABELS.ko);
    expect(html).not.toContain(LANGUAGE_LABELS.en);
    expect(html).not.toContain(LANGUAGE_LABELS.zh);
    expect(html).toContain('Sẵn sàng');
    expect(html).toContain('Cần duyệt');
    expect(html).toContain('Thất bại');
    expect(html).toContain('aria-label="Ngôn ngữ đang chỉnh sửa"');
  });

  it('replaces stale language configuration from canonical conflict state without replay', () => {
    const replay = vi.fn();
    const canonical = {
      revision: 9,
      languages: [{ targetLanguage: 'en' as const, status: 'pending' as const }],
    };

    const recovered = recoverProjectLanguagesConflict(canonical, replay);

    expect(recovered.config).toEqual(canonical);
    expect(recovered.conflictMessage).toContain('mới nhất');
    expect(replay).not.toHaveBeenCalled();
  });
});
