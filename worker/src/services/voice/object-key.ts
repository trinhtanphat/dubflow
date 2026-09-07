import type { TargetLanguage } from '../../domain/language';

export function targetVoiceObjectKey(
  projectId: string,
  targetLanguage: TargetLanguage,
  segmentId: string,
  version: number,
): string {
  return `projects/${projectId}/voices/${targetLanguage}/${segmentId}/${version}.pcm`;
}
