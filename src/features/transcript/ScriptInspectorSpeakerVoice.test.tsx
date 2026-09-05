import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ScriptInspector } from './ScriptInspector';

const segment = {
  id: 'seg-1', speakerId: 'speaker-1', startMs: 1000, endMs: 3000,
  sourceText: '你好', translatedText: 'Xin chào',
};
const speakers = [{
  id: 'speaker-1', projectId: 'project-1', name: 'Nữ chính', label: 'SPEAKER_00', share: 100,
  voiceProvider: 'elevenlabs', voiceId: 'voice-heroine',
}];

describe('ScriptInspector speaker voice controls', () => {
  it('renders persisted ElevenLabs voice id and an explicit save control for cloud speakers', () => {
    const html = renderToStaticMarkup(
      <ScriptInspector
        segment={segment}
        speakers={speakers}
        lipSyncEnabled={false}
        dispatch={vi.fn()}
        cloudEditable
        voiceConfigured
        voiceProviderLabel="ElevenLabs"
      />,
    );
    expect(html).toContain('aria-label="ElevenLabs voice ID"');
    expect(html).toContain('value="voice-heroine"');
    expect(html).toContain('Lưu giọng nhân vật');
    expect(html).toContain('Nữ chính');
  });
});
