import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StudioTopbar } from './StudioTopbar';

describe('StudioTopbar', () => {
  it('renders truthful save/cloud state and accessible command control', () => {
    const html = renderToStaticMarkup(
      <StudioTopbar
        projectTitle="Tập 01"
        saveState="saved"
        cloudState="ready"
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
      />,
    );
    expect(html).toContain('Saved');
    expect(html).toContain('Cloud ready');
    expect(html).toContain('aria-label="Mở bảng lệnh"');
    expect(html).toContain('Tập 01');
  });

  it('shows bounded live cloud progress without losing the processing state', () => {
    const html = renderToStaticMarkup(
      <StudioTopbar
        projectTitle="Cloud episode"
        saveState="offline"
        cloudState="processing"
        cloudProgress={0.47}
        cloudDetail="transcribing"
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
      />,
    );
    expect(html).toContain('Processing');
    expect(html).toContain('47%');
    expect(html).toContain('transcribing');
  });

  it('prioritizes the supplied YupVox reference branding and export copy without hiding live progress', () => {
    const html = renderToStaticMarkup(
      <StudioTopbar
        projectTitle="Thiên Nhai Khách"
        saveState="saved"
        cloudState="processing"
        cloudProgress={0.42}
        cloudDetail="translating"
        canUndo={false}
        canRedo={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
        onOpenSources={() => {}}
        onOpenInspector={() => {}}
      />,
    );

    expect(html).toContain('YupVox.Com');
    expect(html).toContain('AI Studio Dubbing');
    expect(html).toContain('Dự án:');
    expect(html).toContain('reference-project-name');
    expect(html).toContain('brand-wave');
    expect(html).toContain('reference-cloud-status');
    expect(html).toContain('Processing');
    expect(html).toContain('42%');
    expect(html).toContain('Xuất bản Dubbing');
    expect(html).toContain('aria-label="Mở nguồn media"');
    expect(html).toContain('aria-label="Mở inspector"');
  });

  it('enables final export only when the studio marks the project exportable', () => {
    const html = renderToStaticMarkup(
      <StudioTopbar
        projectTitle="Ready"
        saveState="saved"
        cloudState="ready"
        canUndo={false}
        canRedo={false}
        canExport
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
        onExport={() => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*class="export-button reference-export-button"[^>]*>Xuất bản Dubbing<\/button>/);
    expect(html).not.toMatch(/class="export-button reference-export-button"[^>]*disabled/);
  });

  it('shows a project-scoped download action after a durable export exists', () => {
    const html = renderToStaticMarkup(
      <StudioTopbar
        projectTitle="Done"
        saveState="saved"
        cloudState="ready"
        canUndo={false}
        canRedo={false}
        exportHref="/api/projects/p1/export/media"
        onUndo={() => {}}
        onRedo={() => {}}
        onOpenCommands={() => {}}
      />,
    );
    expect(html).toContain('href="/api/projects/p1/export/media"');
    expect(html).toContain('Tải Dubbing');
  });
});
