import { describe, expect, it } from 'vitest';
import studioShellSource from './StudioShell.tsx?raw';

describe('StudioShell sharing mount', () => {
  it('owns share panel visibility and preserves legacy plus concrete export gating', () => {
    expect(studioShellSource).toContain("import { SharePanel } from '../features/sharing/SharePanel'");
    expect(studioShellSource).toContain("const [shareOpen, setShareOpen] = useState(false)");
    expect(studioShellSource).toContain("const [shareExportId, setShareExportId] = useState<string | null>(null)");
    expect(studioShellSource).toContain('canShare={Boolean(exportHref)}');
    expect(studioShellSource).toContain('setShareExportId(null);');
    expect(studioShellSource).toContain('setShareOpen((value) => !value);');
    expect(studioShellSource).toContain('shareOpen && (state.project.exportObjectKey || shareExportId)');
    expect(studioShellSource).toContain('<SharePanel');
    expect(studioShellSource).toContain('projectId={state.project.id}');
    expect(studioShellSource).toContain('exportId={shareExportId ?? undefined}');
  });
});
