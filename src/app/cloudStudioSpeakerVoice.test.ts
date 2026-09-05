import { describe, expect, it } from 'vitest';
import { buildCloudStudioProject } from './cloudStudio';
import type { CloudProject } from '../features/projects/projectApi';
import type { CloudSegment } from '../features/transcript/segmentApi';
import type { CloudSpeaker } from '../features/speakers/speakerApi';

const project: CloudProject = {
  id: 'project-1', userId: 'dev-user', title: 'Tập cloud', sourceLanguage: 'zh', targetLanguage: 'vi',
  status: 'needs_review', durationMs: 4_000, sourceObjectKey: 'projects/project-1/source/source.mp4',
};
const segments: CloudSegment[] = [
  { id: 's1', projectId: 'project-1', speakerId: 'speaker-1', startMs: 0, endMs: 2000, sourceText: '一', translatedText: 'một', translationEngine: 'workers-ai', translationStatus: 'completed', voiceStatus: 'pending', version: 1 },
];
const speakers: CloudSpeaker[] = [
  {
    id: 'speaker-1', projectId: 'project-1', label: 'SPEAKER_00', displayName: 'Nữ chính',
    voiceProvider: 'elevenlabs', voiceId: 'voice-heroine', avatarObjectKey: null,
  },
];

describe('cloud speaker metadata adapter', () => {
  it('hydrates persisted display name and voice assignment into studio speakers', () => {
    const studio = buildCloudStudioProject(project, segments, speakers);
    expect(studio.speakers).toContainEqual({
      id: 'speaker-1',
      projectId: 'project-1',
      name: 'Nữ chính',
      label: 'SPEAKER_00',
      share: 100,
      voiceProvider: 'elevenlabs',
      voiceId: 'voice-heroine',
    });
  });

  it('does not surface stale persisted speakers that have no segment in the current transcript', () => {
    const stale: CloudSpeaker = {
      id: 'speaker-old', projectId: 'project-1', label: 'SPEAKER_OLD', displayName: 'Nhân vật cũ',
      voiceProvider: 'elevenlabs', voiceId: 'voice-old', avatarObjectKey: null,
    };
    const studio = buildCloudStudioProject(project, segments, [...speakers, stale]);
    expect(studio.speakers.map((speaker) => speaker.id)).toEqual(['speaker-1']);
  });
});
