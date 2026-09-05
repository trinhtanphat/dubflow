import { useEffect, useMemo, useRef, useState } from 'react';
import { runStudioCommand, type StudioCommand } from '../../app/studioCommands';

type CommandPaletteProps = {
  open: boolean;
  commands: StudioCommand[];
  onClose(): void;
};

export function filterStudioCommands(commands: StudioCommand[], query: string): StudioCommand[] {
  const normalized = query.trim().toLocaleLowerCase('vi');
  if (!normalized) return commands;
  return commands.filter((command) =>
    `${command.label} ${command.shortcut ?? ''}`.toLocaleLowerCase('vi').includes(normalized),
  );
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleCommands = useMemo(() => filterStudioCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Bảng lệnh Studio">
        <label className="command-palette__search">
          <span className="sr-only">Tìm lệnh</span>
          <input
            ref={inputRef}
            autoFocus
            type="search"
            value={query}
            placeholder="Tìm lệnh…"
            aria-label="Tìm lệnh Studio"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="command-palette__list" role="listbox" aria-label="Lệnh Studio">
          {visibleCommands.length > 0 ? visibleCommands.map((command) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected="false"
              disabled={command.disabled}
              onClick={() => {
                runStudioCommand(command);
                if (!command.disabled) onClose();
              }}
            >
              <span>{command.label}</span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          )) : (
            <p className="command-palette__empty">Không tìm thấy lệnh.</p>
          )}
        </div>
      </section>
    </div>
  );
}
