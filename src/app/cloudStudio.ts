import type { CloudProject } from '../features/projects/projectApi';
import type { CloudSpeaker } from '../features/speakers/speakerApi';
import type { CloudSegment } from '../features/transcript/segmentApi';
import type { Speaker, StudioProject } from '../features/timeline/types';

const UNASSIGNED_SPEAKER_ID = 'unassigned';

function studioSpeakerId(segment: CloudSegment): string {
  return segment.speakerId?.trim() || UNASSIGNED_SPEAKER_ID;
}

function buildSpeakers(segments: CloudSegment[], metadata: CloudSpeaker[]): Speaker[] {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const id = studioSpeakerId(segment);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const metadataById = new Map(metadata.map((speaker) => [speaker.id, speaker]));
  if (counts.size === 0) counts.set(UNASSIGNED_SPEAKER_ID, 0);
  const total = Math.max(1, segments.length);

  return [...counts.entries()].map(([id, count]) => {
    if (id === UNASSIGNED_SPEAKER_ID) {
      return {
        id,
        name: 'Chưa gán',
        label: 'AI transcript',
        share: segments.length ? Math.round((count / total) * 100) : 0,
      };
    }
    const persisted = metadataById.get(id);
    return {
      id,
      projectId: persisted?.projectId,
      name: persisted?.displayName ?? id,
      label: persisted?.label ?? 'Nhân vật',
      share: Math.round((count / total) * 100),
      voiceProvider: persisted?.voiceProvider ?? null,
      voiceId: persisted?.voiceId ?? null,
    };
  });
}

export function buildCloudStudioProject(
  project: CloudProject,
  segments: CloudSegment[],
  speakers: CloudSpeaker[] = [],
): StudioProject {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  const lastEnd = ordered.reduce((max, segment) => Math.max(max, segment.endMs), 0);
  const durationMs = typeof project.durationMs === 'number' && Number.isFinite(project.durationMs) && project.durationMs > 0
    ? project.durationMs
    : lastEnd;

  return {
    id: project.id,
    title: project.title,
    durationMs,
    sourceLanguage: project.sourceLanguage,
    targetLanguage: project.targetLanguage,
    sourceObjectKey: project.sourceObjectKey ?? null,
    exportObjectKey: project.exportObjectKey ?? null,
    status: project.status,
    speakers: buildSpeakers(ordered, speakers),
    segments: ordered.map((segment) => ({
      id: segment.id,
      speakerId: studioSpeakerId(segment),
      startMs: segment.startMs,
      endMs: segment.endMs,
      sourceText: segment.sourceText,
      translatedText: segment.translatedText,
    })),
  };
}
