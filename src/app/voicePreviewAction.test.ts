import { describe, expect, it, vi } from 'vitest';
import { createVoicePreviewAction } from './voicePreviewAction';

describe('voice preview action', () => {
  it('passes the selected speaker voice id to the preview API', async () => {
    const fetchVoicePreview = vi.fn(async () => new Blob(['audio'], { type: 'audio/mpeg' }));
    const action = createVoicePreviewAction({
      setBusy: vi.fn(),
      setError: vi.fn(),
      services: {
        fetchVoicePreview,
        createObjectURL: () => 'blob:preview',
        revokeObjectURL: vi.fn(),
        playAudio: vi.fn(async () => {}),
      },
    });

    await action(' Xin chào ', ' voice-heroine ');

    expect(fetchVoicePreview).toHaveBeenCalledWith({
      text: 'Xin chào',
      language: 'vi',
      voice: 'voice-heroine',
    });
  });

  it('keeps the default provider voice path when no speaker voice is assigned', async () => {
    const fetchVoicePreview = vi.fn(async () => new Blob(['audio'], { type: 'audio/mpeg' }));
    const action = createVoicePreviewAction({
      setBusy: vi.fn(),
      setError: vi.fn(),
      services: {
        fetchVoicePreview,
        createObjectURL: () => 'blob:preview',
        revokeObjectURL: vi.fn(),
        playAudio: vi.fn(async () => {}),
      },
    });

    await action('Xin chào');

    expect(fetchVoicePreview).toHaveBeenCalledWith({ text: 'Xin chào', language: 'vi' });
  });
});
