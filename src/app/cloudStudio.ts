import type { CloudProject } from '../features/projects/projectApi';
import type { CloudSegment } from '../features/transcript/segmentApi';
import type { Speaker, StudioProject } from '../features/timeline/types';

const UNASSIGNED_SPEAKER_ID = 'unassigned';

function studioSpeakerId(segment: CloudSegment): string {
  return segment.speakerId?.trim() || UNASSIGNED_SPEAKER_ID;
}

function buildSpeakers(segments: CloudSegment[]): Speaker[] {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const id = studioSpeakerId(segment);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (counts.size === 0) counts.set(UNASSIGNED_SPEAKER_ID, 0);
  const total = Math.max(1, segments.length);
  return [...counts.entries()].map(([id, count]) => id === UNASSIGNED_SPEAKER_ID
    ? { id, name: 'Chưa gán', label: 'AI transcript', share: segments.length ? Math.round((count / total) * 100) : 0 }
    : { id, name: id, label: 'Nhân vật', share: Math.round((count / total) * 100) });
}

export function buildCloudStudioProject(project: CloudProject, segments: CloudSegment[]): StudioProject {
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
    speakers: buildSpeakers(ordered),
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
