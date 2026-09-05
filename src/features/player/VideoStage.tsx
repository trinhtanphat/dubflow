import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import { IconButton } from '../../components/IconButton/IconButton';
import type { StudioAction, StudioState } from '../../app/studioState';
import type { Segment, StudioProject } from '../timeline/types';
import { frameStepMs, mediaUrlForProject } from './playback';
import { formatTimestamp } from './time';

type VideoStageProps = {
  project: StudioProject;
  segment?: Segment;
  playheadMs: number;
  playback: StudioState['playback'];
  dispatch: Dispatch<StudioAction>;
};

const RATES: StudioState['playback']['rate'][] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function VideoStage({ project, segment, playheadMs, playback, dispatch }: VideoStageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaUrl = mediaUrlForProject(project);
  const progress = project.durationMs > 0 ? Math.min(100, Math.max(0, playheadMs / project.durationMs * 100)) : 0;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playback.rate;
    video.volume = playback.volume;
    video.muted = playback.muted;
  }, [playback.rate, playback.volume, playback.muted, mediaUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.currentTime)) return;
    if (Math.abs(video.currentTime * 1000 - playheadMs) > 100) {
      video.currentTime = Math.max(0, playheadMs) / 1000;
    }
  }, [playheadMs, mediaUrl]);

  const seekToMs = (ms: number) => {
    const target = Math.max(0, Math.min(project.durationMs, ms));
    if (videoRef.current) videoRef.current.currentTime = target / 1000;
    dispatch({ type: 'setPlayhead', playheadMs: target });
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => dispatch({ type: 'setPlaying', playing: false }));
    } else {
      video.pause();
    }
  };

  const stepFrame = (direction: -1 | 1) => {
    videoRef.current?.pause();
    dispatch({ type: 'setPlaying', playing: false });
    seekToMs(playheadMs + direction * frameStepMs(project.frameRate));
  };

  const cycleRate = () => {
    const index = RATES.indexOf(playback.rate);
    dispatch({ type: 'setPlaybackRate', rate: RATES[(index + 1) % RATES.length] ?? 1 });
  };

  const enterFullscreen = () => {
    const video = videoRef.current;
    if (video?.requestFullscreen) void video.requestFullscreen();
  };

  const stageContent = mediaUrl ? (
    <video
      ref={videoRef}
      className="studio-video"
      src={mediaUrl}
      aria-label="Video source"
      preload="metadata"
      playsInline
      onTimeUpdate={(event) => dispatch({ type: 'setPlayhead', playheadMs: event.currentTarget.currentTime * 1000 })}
      onPlay={() => dispatch({ type: 'setPlaying', playing: true })}
      onPause={() => dispatch({ type: 'setPlaying', playing: false })}
      onEnded={() => dispatch({ type: 'setPlaying', playing: false })}
    />
  ) : project.status === 'processing' ? (
    <div className="video-processing-state" role="status">
      <strong>Media đang được xử lý</strong>
      <span>YupVox sẽ bật player ngay khi source media sẵn sàng.</span>
    </div>
  ) : (
    <div className="video-empty-state">
      <strong>Chưa có media phát được</strong>
      <span>Tải video lên để bắt đầu preview và đồng bộ timeline.</span>
    </div>
  );

  return (
    <section className="video-stage" aria-label="Video preview">
      <div className="video-stage__surface reference-video-frame">
        {stageContent}
        <div className="subtitle-overlay" aria-live="off">
          <div className="subtitle-source" lang="zh-CN">{segment?.sourceText ?? ''}</div>
          <div className="subtitle-target">{segment?.translatedText ?? ''}</div>
        </div>
      </div>

      <div className="progress-track" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
        <span style={{ left: `${progress}%` }} />
      </div>

      <div className="transport-bar reference-transport-row">
        <div className="transport-time">{formatTimestamp(playheadMs / 1000)} / {formatTimestamp(project.durationMs / 1000)}</div>
        <div className="transport-controls">
          <IconButton icon="−1f" label="Lùi một khung hình" onClick={() => stepFrame(-1)} disabled={!mediaUrl} />
          <IconButton icon="−5" label="Lùi 5 giây" onClick={() => seekToMs(playheadMs - 5000)} disabled={!mediaUrl} />
          <button className="play-button" type="button" aria-label={playback.playing ? 'Tạm dừng video' : 'Phát video'} onClick={togglePlay} disabled={!mediaUrl}>
            {playback.playing ? '❚❚' : '▶'}
          </button>
          <IconButton icon="+5" label="Tiến 5 giây" onClick={() => seekToMs(playheadMs + 5000)} disabled={!mediaUrl} />
          <IconButton icon="+1f" label="Tiến một khung hình" onClick={() => stepFrame(1)} disabled={!mediaUrl} />
        </div>
        <div className="transport-actions">
          <IconButton icon={playback.muted ? '🔇' : '♪'} label={playback.muted ? 'Bật âm thanh' : 'Tắt âm thanh'} onClick={() => dispatch({ type: 'toggleMuted' })} disabled={!mediaUrl} />
          <button className="player-rate-button" type="button" onClick={cycleRate} disabled={!mediaUrl} aria-label="Đổi tốc độ phát">{playback.rate}x</button>
          <IconButton icon="⛶" label="Toàn màn hình" onClick={enterFullscreen} disabled={!mediaUrl} />
        </div>
      </div>
    </section>
  );
}
