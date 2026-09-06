import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Phase4CStudioProvider, type Phase4CStudioContextValue } from '../../app/phase4cStudioContext';

const refs = vi.hoisted(() => ({ captured: null as any }));

vi.mock('./ScriptInspectorBase', () => ({
  ScriptInspector: (props: unknown) => {
    refs.captured = props;
    return <div>base inspector</div>;
  },
  INSPECTOR_TABS: [],
  resolveSegmentSpeakerVoice: () => undefined,
}));

import { ScriptInspector } from './ScriptInspector';

const segment = {
  id: 'seg-1',
  speakerId: 'speaker-1',
  startMs: 0,
  endMs: 1000,
  sourceText: 'source',
  translatedText: 'legacy vi',
  version: 3,
};

function renderWithPhase(value: Phase4CStudioContextValue, onEditDraft: ReturnType<typeof vi.fn>, onFlushDraft: ReturnType<typeof vi.fn>) {
  renderToStaticMarkup(
    <Phase4CStudioProvider value={value}>
      <ScriptInspector
        segment={segment}
        speakers={[]}
        lipSyncEnabled={false}
        dispatch={vi.fn()}
        cloudEditable
        onEditDraft={onEditDraft}
        onFlushDraft={onFlushDraft}
      />
    </Phase4CStudioProvider>,
  );
}

describe('ScriptInspector Phase 4C compatibility', () => {
  it('keeps Vietnamese edits on legacy autosave until a canonical target row exists', () => {
    const onEditDraft = vi.fn();
    const onFlushDraft = vi.fn();
    const editTargetTranslation = vi.fn();
    const flushTargetTranslation = vi.fn(async () => {});
    const phase: Phase4CStudioContextValue = {
      currentLanguage: 'vi',
      targetLanguage: 'vi',
      targetSegments: [],
      targetDrafts: {},
      targetConflict: '',
      editTargetTranslation,
      flushTargetTranslation,
    };

    renderWithPhase(phase, onEditDraft, onFlushDraft);
    refs.captured.onEditDraft('seg-1', { translatedText: 'legacy draft' });
    refs.captured.onFlushDraft('seg-1');

    expect(onEditDraft).toHaveBeenCalledWith('seg-1', { translatedText: 'legacy draft' });
    expect(onFlushDraft).toHaveBeenCalledWith('seg-1');
    expect(editTargetTranslation).not.toHaveBeenCalled();
    expect(flushTargetTranslation).not.toHaveBeenCalled();
  });
});
