import { describe, expect, it } from 'vitest';
import studioShellSource from './StudioShell.tsx?raw';

describe('StudioShell sharing mount', () => {
  it('owns share panel visibility and gates the panel on a durable export', () => {
    expect(studioShellSource).toContain("import { SharePanel } from '../features/sharing/SharePanel'");
    expect(studioShellSource).toContain("const [shareOpen, setShareOpen] = useState(false)");
    expect(studioShellSource).toContain('canShare={Boolean(exportHref)}');
    expect(studioShellSource).toContain('onShare={() => setShareOpen((value) => !value)}');
    expect(studioShellSource).toContain('shareOpen && state.project.exportObjectKey');
    expect(studioShellSource).toContain('<SharePanel projectId={state.project.id}');
  });
});
