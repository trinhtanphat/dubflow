import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CommandPalette, filterStudioCommands } from './CommandPalette';

const commands = [
  { id: 'split-segment', label: 'Tách segment', shortcut: 'S', run: vi.fn() },
  { id: 'undo', label: 'Hoàn tác', shortcut: 'Ctrl/⌘ Z', disabled: true, run: vi.fn() },
  { id: 'open-inspector', label: 'Mở inspector', run: vi.fn() },
];

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <CommandPalette open={false} commands={commands} onClose={() => {}} />,
    );
    expect(html).toBe('');
  });

  it('renders an accessible palette with shortcuts and disabled state when open', () => {
    const html = renderToStaticMarkup(
      <CommandPalette open commands={commands} onClose={() => {}} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Bảng lệnh Studio"');
    expect(html).toContain('Tách segment');
    expect(html).toContain('Ctrl/⌘ Z');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Hoàn tác/s);
  });

  it('filters commands by normalized label text', () => {
    expect(filterStudioCommands(commands, 'INSPECTOR').map((command) => command.id)).toEqual(['open-inspector']);
    expect(filterStudioCommands(commands, '   ')).toHaveLength(3);
  });
});
