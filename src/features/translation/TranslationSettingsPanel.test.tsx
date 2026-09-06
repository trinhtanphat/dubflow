import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const glossary = [
  {
    id: 'g1',
    projectId: 'cloud-p1',
    targetLanguage: 'vi' as const,
    sourceTerm: 'Acme',
    preferredTranslation: 'Acme',
    note: 'Tên thương hiệu',
    caseSensitive: true,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
  },
  {
    id: 'g2',
    projectId: 'cloud-p1',
    targetLanguage: 'vi' as const,
    sourceTerm: 'Azure Gate',
    preferredTranslation: 'Cổng Azure',
    note: null,
    caseSensitive: false,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
  },
];

async function panelModule() {
  return import('./TranslationSettingsPanel');
}

describe('TranslationSettingsPanel view contract', () => {
  it('renders all five Vietnamese style labels, contextual capability, glossary count and edit controls', async () => {
    const panel = await panelModule();
    const html = renderToStaticMarkup(
      <panel.TranslationSettingsPanelView
        settings={{ stylePreset: 'natural', contextRevision: 4, contextualAvailable: false }}
        glossary={glossary}
        filter=""
        draft={{ sourceTerm: 'Acme', preferredTranslation: 'Acme', note: 'Tên thương hiệu', caseSensitive: true }}
        editingEntryId="g1"
        loading={false}
        saving={false}
        error=""
        changed
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

    for (const label of ['Trung tính', 'Tự nhiên', 'Trang trọng', 'Thân mật', 'Điện ảnh']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Dịch theo ngữ cảnh chưa khả dụng');
    expect(html).toContain('2 / 200');
    expect(html).toContain('Tên thương hiệu');
    expect(html).toContain('Phân biệt hoa thường');
    expect(html).toContain('aria-label="Tìm thuật ngữ"');
    expect(html).toContain('Thiết lập dịch đã thay đổi');
  });

  it('filters glossary locally and validates bounded glossary drafts', async () => {
    const panel = await panelModule();

    expect(panel.filterGlossaryEntries(glossary, 'azure')).toEqual([glossary[1]]);
    expect(panel.filterGlossaryEntries(glossary, 'CỔNG')).toEqual([glossary[1]]);
    expect(panel.validateGlossaryDraft({
      sourceTerm: '',
      preferredTranslation: 'Acme',
      note: null,
      caseSensitive: false,
    })).toBe('Thuật ngữ nguồn không được để trống.');
    expect(panel.validateGlossaryDraft({
      sourceTerm: 'A'.repeat(121),
      preferredTranslation: 'Acme',
      note: null,
      caseSensitive: false,
    })).toContain('120');
    expect(panel.validateGlossaryDraft({
      sourceTerm: 'Acme',
      preferredTranslation: 'B'.repeat(201),
      note: null,
      caseSensitive: false,
    })).toContain('200');
    expect(panel.validateGlossaryDraft({
      sourceTerm: 'Acme',
      preferredTranslation: 'Acme',
      note: 'C'.repeat(301),
      caseSensitive: false,
    })).toContain('300');
    expect(panel.validateGlossaryDraft({
      sourceTerm: 'Acme',
      preferredTranslation: 'Acme',
      note: null,
      caseSensitive: false,
    })).toBeNull();
  });

  it('recovers a stale mutation from the canonical context without replaying it', async () => {
    const panel = await panelModule();
    const replay = vi.fn();
    const canonical = {
      revision: 9,
      style: 'formal' as const,
      glossary: [glossary[1]],
    };

    const recovered = panel.recoverTranslationContextConflict(canonical, replay);

    expect(recovered).toEqual({
      settings: { stylePreset: 'formal', contextRevision: 9 },
      glossary: [glossary[1]],
      conflictMessage: 'Thiết lập dịch đã thay đổi ở nơi khác. Đã tải bản mới nhất.',
    });
    expect(replay).not.toHaveBeenCalled();
  });
});
