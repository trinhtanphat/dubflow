import { describe, expect, it } from 'vitest';
import { buildCloudStudioProject } from './cloudStudio';
import type { CloudProject } from '../features/projects/projectApi';
import type { CloudSegment } from '../features/transcript/segmentApi';

const project: CloudProject = {
  id: 'project-1', userId: 'dev-user', title: 'Tập cloud', sourceLanguage: 'zh', targetLanguage: 'vi',
  status: 'needs_review', durationMs: 12_000, sourceObjectKey: 'projects/project-1/source/source.mp4',
};
const segments: CloudSegment[] = [
  { id: 'b', projectId: 'project-1', speakerId: null, startMs: 5000, endMs: 7000, sourceText: '二', translatedText: 'hai', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 1 },
  { id: 'a', projectId: 'project-1', speakerId: null, startMs: 1000, endMs: 3000, sourceText: '一', translatedText: 'một', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 1 },
];

describe('cloud studio adapter', () => {
  it('hydrates deterministic timeline data, media readiness and null speakers', () => {
    const studio = buildCloudStudioProject(project, segments);
    expect(studio.id).toBe('project-1');
    expect(studio.durationMs).toBe(12_000);
    expect(studio.sourceObjectKey).toBe('projects/project-1/source/source.mp4');
    expect(studio.status).toBe('needs_review');
    expect(studio.segments.map((segment) => segment.id)).toEqual(['a', 'b']);
    expect(studio.segments.every((segment) => segment.speakerId === 'unassigned')).toBe(true);
    expect(studio.speakers).toContainEqual({ id: 'unassigned', name: 'Chưa gán', label: 'AI transcript', share: 100 });
  });

  it('falls back to the latest segment end when project duration has not been persisted', () => {
    expect(buildCloudStudioProject({ ...project, durationMs: null }, segments).durationMs).toBe(7000);
  });
});
