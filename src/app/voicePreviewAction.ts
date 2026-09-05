import { fetchVoicePreview } from '../features/voice/voiceApi';

type VoicePreviewServices = {
  fetchVoicePreview: typeof fetchVoicePreview;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  playAudio: (url: string) => Promise<void>;
};

type CreateVoicePreviewActionOptions = {
  setBusy: (busy: boolean) => void;
  setError: (message: string) => void;
  services?: VoicePreviewServices;
};

const defaultServices: VoicePreviewServices = {
  fetchVoicePreview,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  playAudio: async (url) => {
    const audio = new Audio(url);
    await audio.play();
    await new Promise<void>((resolve) => {
      if (audio.ended) resolve();
      else audio.addEventListener('ended', () => resolve(), { once: true });
    });
  },
};

export function createVoicePreviewAction({ setBusy, setError, services = defaultServices }: CreateVoicePreviewActionOptions) {
  return async (inputText: string, inputVoice?: string) => {
    const text = inputText.trim();
    if (!text) return;
    const voice = inputVoice?.trim();

    setBusy(true);
    setError('');
    let objectUrl = '';
    try {
      const blob = await services.fetchVoicePreview(
        voice ? { text, language: 'vi', voice } : { text, language: 'vi' },
      );
      objectUrl = services.createObjectURL(blob);
      await services.playAudio(objectUrl);
    } catch (error) {
      setError(error instanceof Error && error.message ? error.message : 'Không thể phát preview giọng nói.');
    } finally {
      if (objectUrl) services.revokeObjectURL(objectUrl);
      setBusy(false);
    }
  };
}
