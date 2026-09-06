import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockProject } from './mockProject';
import { createInitialStudioState } from './studioState';
import { composeTargetSegment, StudioShell } from './StudioShell';

function renderProject(projectId: string) {
  const state = createInitialStudioState({ ...mockProject, id: projectId });
  return renderToStaticMarkup(
    <StudioShell
      state={state}
      dispatch={() => {}}
      selectedSegment={state.project.segments[0]}
      selectedSpeaker={state.project.speakers[0]}
    />,
  );
}

describe('StudioShell translation settings integration', () => {
  it('renders translation settings for a real cloud project', () => {
    const html = renderProject('cloud-p1');
    expect(html).toContain('data-testid="translation-settings-panel"');
  });

  it('renders target-language and batch-export controls for a cloud project only', () => {
    const cloud = renderProject('cloud-p1');
    const demo = renderProject('demo');

    expect(cloud).toContain('data-testid="target-languages-panel"');
    expect(cloud).toContain('data-testid="batch-export-panel"');
    expect(demo).not.toContain('data-testid="target-languages-panel"');
    expect(demo).not.toContain('data-testid="batch-export-panel"');
  });

  it('does not expose server-backed translation settings for the demo project', () => {
    const html = renderProject('demo');
    expect(html).not.toContain('data-testid="translation-settings-panel"');
  });

  it('overlays only target translated text while preserving canonical source timing and speaker identity', () => {
    const canonical = mockProject.segments[0]!;
    const variant = {
      segmentId: canonical.id,
      speakerId: canonical.speakerId,
      startMs: canonical.startMs,
      endMs: canonical.endMs,
      sourceText: canonical.sourceText,
      sourceVersion: canonical.version,
      translation: {
        segmentId: canonical.id,
        projectId: 'cloud-p1',
        targetLanguage: 'ja' as const,
        translatedText: 'こんにちは',
        translationEngine: 'workers-ai',
        translationStatus: 'completed',
        translationContextRevision: 8,
        voiceStatus: 'pending',
        dubbedObjectKey: null,
        version: 11,
      },
    };

    const composed = composeTargetSegment(canonical, variant);

    expect(composed).toMatchObject({
      id: canonical.id,
      sourceText: canonical.sourceText,
      startMs: canonical.startMs,
      endMs: canonical.endMs,
      speakerId: canonical.speakerId,
      version: canonical.version,
      translatedText: 'こんにちは',
    });
  });
});
