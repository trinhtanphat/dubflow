import type { ComponentProps } from 'react';
import { composeTargetSegment, usePhase4CStudio } from '../../app/phase4cStudioContext';
import { ScriptInspector as BaseScriptInspector } from './ScriptInspectorBase';

export { INSPECTOR_TABS, resolveSegmentSpeakerVoice } from './ScriptInspectorBase';
export type { InspectorTab } from './ScriptInspectorBase';

type Props = ComponentProps<typeof BaseScriptInspector>;

export function ScriptInspector(props: Props) {
  const phase = usePhase4CStudio();
  const canonical = props.segment;
  const targetRow = canonical && phase?.targetLanguage
    ? phase.targetSegments.find((row) => row.segmentId === canonical.id) ?? null
    : null;
  const targetDraftText = canonical && phase?.targetLanguage
    ? phase.targetDrafts[canonical.id]
    : undefined;
  const useVietnameseCompatibility = Boolean(
    canonical
    && phase?.targetLanguage === 'vi'
    && !targetRow
    && targetDraftText === undefined,
  );
  const segment = canonical && phase?.targetLanguage
    ? useVietnameseCompatibility
      ? canonical
      : composeTargetSegment(canonical, targetRow, targetDraftText)
    : canonical;

  const editDraft: Props['onEditDraft'] = (segmentId, patch) => {
    if (!phase?.targetLanguage || useVietnameseCompatibility) {
      props.onEditDraft?.(segmentId, patch);
      return;
    }
    if (patch.translatedText !== undefined) {
      phase.editTargetTranslation(segmentId, patch.translatedText);
    }
    const canonicalPatch = {
      ...(patch.sourceText !== undefined ? { sourceText: patch.sourceText } : {}),
      ...(patch.speakerId !== undefined ? { speakerId: patch.speakerId } : {}),
    };
    if (Object.keys(canonicalPatch).length > 0) props.onEditDraft?.(segmentId, canonicalPatch);
  };

  const flushDraft: Props['onFlushDraft'] = (segmentId) => {
    props.onFlushDraft?.(segmentId);
    if (phase?.targetLanguage && !useVietnameseCompatibility) void phase.flushTargetTranslation(segmentId);
  };

  const canonicalDraft = phase?.targetLanguage && props.draft && !useVietnameseCompatibility
    ? {
        ...props.draft,
        patch: {
          ...(props.draft.patch.sourceText !== undefined ? { sourceText: props.draft.patch.sourceText } : {}),
          ...(props.draft.patch.speakerId !== undefined ? { speakerId: props.draft.patch.speakerId } : {}),
        },
      }
    : props.draft;

  return (
    <>
      <BaseScriptInspector
        {...props}
        segment={segment}
        draft={canonicalDraft}
        onEditDraft={editDraft}
        onFlushDraft={flushDraft}
      />
      {phase?.targetConflict && (
        <p className="phase4c-target-conflict" role="alert">{phase.targetConflict}</p>
      )}
    </>
  );
}
