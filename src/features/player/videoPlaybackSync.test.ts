import { describe, expect, it, vi } from 'vitest';
import { syncVideoPlayback } from './videoPlaybackSync';

type FakeVideo = {
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
};

function fakeVideo(paused: boolean): FakeVideo {
  return {
    paused,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  };
}

describe('syncVideoPlayback', () => {
  it('starts a paused media element when editor playback becomes active', async () => {
    const video = fakeVideo(true);
    await syncVideoPlayback(video, true);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it('pauses a playing media element when editor playback becomes inactive', async () => {
    const video = fakeVideo(false);
    await syncVideoPlayback(video, false);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('does not replay media already playing', async () => {
    const video = fakeVideo(false);
    await syncVideoPlayback(video, true);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('reports a play rejection so editor state can fail closed', async () => {
    const video = fakeVideo(true);
    const error = new Error('autoplay blocked');
    video.play.mockRejectedValue(error);
    const onPlayError = vi.fn();
    await syncVideoPlayback(video, true, onPlayError);
    expect(onPlayError).toHaveBeenCalledWith(error);
  });
});
