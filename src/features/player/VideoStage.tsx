import { useEffect, useMemo, useRef, useState } from 'react';
import { Expand, Gauge, Maximize2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import type { Segment } from '../timeline/types';
import { formatTimestamp } from './time';
import { IconButton } from '../../components/ui/IconButton';

type Props = {
  file: File | null;
  segment: Segment;
  currentMs: number;
  durationMs: number;
  playing: boolean;
  onTogglePlay: () => void;
};

export function VideoStage({ file, segment, currentMs, durationMs, playing, onTogglePlay }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const objectUrl = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !objectUrl) return;
    if (playing) void video.play().catch(() => undefined); else video.pause();
  }, [playing, objectUrl]);

  return (
    <section className="video-stage" aria-label="Trình phát video">
      <div className="video-canvas">
        {objectUrl ? <video ref={videoRef} src={objectUrl} muted={muted} poster="/demo-frame.svg" /> : <img className="demo-frame" src="/demo-frame.svg" alt="Khung hình demo DubFlow" />}
        <div className="subtitle-stack">
          <div className="subtitle source-subtitle">{segment.sourceText}</div>
          <div className="subtitle translated-subtitle">{segment.translatedText}</div>
        </div>
      </div>
      <div className="player-progress"><span style={{ width: `${Math.min(100, (currentMs / durationMs) * 100)}%` }} /><i style={{ left: `${Math.min(100, (currentMs / durationMs) * 100)}%` }} /></div>
      <div className="player-controls">
        <div className="player-time"><strong>{formatTimestamp(currentMs)}</strong> <span>/ {formatTimestamp(durationMs, true)}</span></div>
        <div className="transport">
          <IconButton aria-label="Đoạn trước"><SkipBack size={18}/></IconButton>
          <IconButton className="play-button" aria-label={playing ? 'Tạm dừng' : 'Phát'} onClick={onTogglePlay}>{playing ? <Pause size={22}/> : <Play size={22} fill="currentColor"/>}</IconButton>
          <IconButton aria-label="Đoạn sau"><SkipForward size={18}/></IconButton>
        </div>
        <div className="player-tools">
          <IconButton aria-label="Âm lượng" onClick={() => setMuted((value) => !value)}><Volume2 size={17}/></IconButton>
          <button className="speed-button" type="button"><Gauge size={14}/>1.0x</button>
          <IconButton aria-label="Vừa khung"><Expand size={17}/></IconButton>
          <IconButton aria-label="Toàn màn hình"><Maximize2 size={17}/></IconButton>
        </div>
      </div>
    </section>
  );
}
