import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TranslationSettingsPanelView } from './TranslationSettingsPanel';

describe('Phase 4C target-aware glossary presentation', () => {
  it('shows a glossary target selector while keeping translation style project-global', () => {
    const html = renderToStaticMarkup(
      <TranslationSettingsPanelView
        settings={{ stylePreset: 'formal', contextRevision: 4, contextualAvailable: true }}
        glossary={[]}
        filter=""
        draft={null}
        editingEntryId={null}
        loading={false}
        saving={false}
        error=""
        changed={false}
        conflictMessage=""
        onFilterChange={vi.fn()}
        onStyleChange={vi.fn()}
        onStartCreate={vi.fn()}
        onStartEdit={vi.fn()}
        onDraftChange={vi.fn()}
        onCancelEdit={vi.fn()}
        onSaveDraft={vi.fn()}
        onDeleteEntry={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Ngôn ngữ thuật ngữ"');
    expect(html).toContain('Tiếng Việt');
    expect(html).toContain('English');
    expect(html).toContain('中文');
    expect(html).toContain('日本語');
    expect(html).toContain('한국어');
    expect((html.match(/name="translation-style"/g) ?? []).length).toBe(5);
  });
});
