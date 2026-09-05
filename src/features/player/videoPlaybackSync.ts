export type VideoPlaybackTarget = {
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
};

export async function syncVideoPlayback(
  video: VideoPlaybackTarget,
  playing: boolean,
  onPlayError?: (error: unknown) => void,
): Promise<void> {
  if (!playing) {
    if (!video.paused) video.pause();
    return;
  }

  if (!video.paused) return;

  try {
    await video.play();
  } catch (error) {
    onPlayError?.(error);
  }
}
