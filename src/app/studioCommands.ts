export type StudioCommand = {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run(): void;
};

export type StudioCommandInput = {
  canSplit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  split(): void;
  undo(): void;
  redo(): void;
  zoomIn(): void;
  zoomOut(): void;
  openSources(): void;
  openInspector(): void;
};

export function runStudioCommand(command: StudioCommand): void {
  if (command.disabled) return;
  command.run();
}

export function buildStudioCommands(input: StudioCommandInput): StudioCommand[] {
  return [
    {
      id: 'split-segment',
      label: 'Tách segment tại playhead',
      shortcut: 'S',
      disabled: !input.canSplit,
      run: input.split,
    },
    {
      id: 'undo',
      label: 'Hoàn tác',
      shortcut: 'Ctrl/⌘ Z',
      disabled: !input.canUndo,
      run: input.undo,
    },
    {
      id: 'redo',
      label: 'Làm lại',
      shortcut: 'Ctrl/⌘ ⇧ Z',
      disabled: !input.canRedo,
      run: input.redo,
    },
    {
      id: 'zoom-in',
      label: 'Phóng to timeline',
      shortcut: '+',
      run: input.zoomIn,
    },
    {
      id: 'zoom-out',
      label: 'Thu nhỏ timeline',
      shortcut: '-',
      run: input.zoomOut,
    },
    {
      id: 'open-sources',
      label: 'Mở nguồn media',
      run: input.openSources,
    },
    {
      id: 'open-inspector',
      label: 'Mở inspector',
      run: input.openInspector,
    },
  ];
}
