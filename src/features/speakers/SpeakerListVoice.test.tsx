import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpeakerList } from './SpeakerList';

const speakers = [{
  id: 'speaker-1', projectId: 'project-1', name: 'Nữ chính', label: 'SPEAKER_00', share: 100,
  voiceProvider: 'elevenlabs', voiceId: 'voice-heroine',
}];

describe('speaker voice controls', () => {
  it('renders persisted ElevenLabs voice id and an explicit save control for the selected cloud speaker', () => {
    const html = renderToStaticMarkup(
      <SpeakerList speakers={speakers} selectedSpeakerId="speaker-1" />,
    );
    expect(html).toContain('aria-label="Tên nhân vật"');
    expect(html).toContain('value="Nữ chính"');
    expect(html).toContain('aria-label="ElevenLabs voice ID"');
    expect(html).toContain('value="voice-heroine"');
    expect(html).toContain('Lưu giọng nhân vật');
  });
});
