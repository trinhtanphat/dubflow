import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  LANGUAGE_LABELS,
  TargetLanguagesPanelView,
  recoverProjectLanguagesConflict,
} from './TargetLanguagesPanel';

const config = {
  revision: 6,
  languages: [
    { targetLanguage: 'vi' as const, status: 'ready' as const },
    { targetLanguage: 'ja' as const, status: 'translating' as const },
    { targetLanguage: 'ko' as const, status: 'failed' as const },
  ],
};

describe('Phase 4C target-language studio controls', () => {
  it('renders Source plus enabled targets with truthful localized labels and statuses', () => {
    const html = renderToStaticMarkup(
      <TargetLanguagesPanelView
        config={config}
        currentLanguage="ja"
        selectedLanguages={['vi', 'ja']}
        saving={false}
        processingLanguage={null}
        error=""
        onCurrentLanguageChange={vi.fn()}
        onToggleEnabled={vi.fn()}
        onSaveEnabled={vi.fn()}
        onToggleSelected={vi.fn()}
        onProcessLanguage={vi.fn()}
      />,
    );

    expect(LANGUAGE_LABELS).toEqual({
      vi: 'Tiếng Việt',
      en: 'English',
      zh: '中文',
      ja: '日本語',
      ko: '한국어',
    });
    expect(html).toContain('value="source"');
    expect(html).toContain('Source');
    expect(html).toContain('日本語');
    expect(html).toContain('한국어');
    expect(html).toContain('Sẵn sàng');
    expect(html).toContain('Đang dịch');
    expect(html).toContain('Thất bại');
    expect(html).toContain('aria-label="Ngôn ngữ đang chỉnh sửa"');
  });

  it('replaces stale language configuration with canonical server state without replaying the mutation', () => {
    const replay = vi.fn();
    const canonical = {
      revision: 9,
      languages: [{ targetLanguage: 'vi' as const, status: 'ready' as const }],
    };

    expect(recoverProjectLanguagesConflict(canonical, replay)).toEqual(canonical);
    expect(replay).not.toHaveBeenCalled();
  });
});
