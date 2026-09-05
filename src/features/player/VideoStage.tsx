import { IconButton } from '../../components/ui/IconButton';
import type { Segment } from '../timeline/types';
import { formatTimestamp } from './time';

type VideoStageProps = { segment?: Segment; playheadMs: number; durationMs: number };
export function VideoStage({ segment, playheadMs, durationMs }: VideoStageProps) {
  const progress = durationMs > 0 ? Math.min(100, Math.max(0, playheadMs / durationMs * 100)) : 0;
  return <section className="video-stage" aria-label="Video preview"><div className="video-stage__art"><div className="moon" /><div className="pagoda pagoda--back" /><div className="character character--left"><span /></div><div className="character character--right"><span /></div><div className="video-vignette" /><div className="subtitle-overlay"><div className="subtitle-source">{segment?.sourceText ?? '你终于来了，我等你很久了。'}</div><div className="subtitle-target">{segment?.translatedText ?? 'Cuối cùng chàng cũng đến, ta đã đợi chàng rất lâu rồi.'}</div></div></div><div className="progress-track"><i style={{ width: `${progress}%` }} /><span style={{ left: `${progress}%` }} /></div><div className="transport-bar"><div className="transport-time">{formatTimestamp(playheadMs / 1000)} / {formatTimestamp(durationMs / 1000)}</div><div className="transport-controls"><IconButton icon="↤" label="Phân đoạn trước" /><button className="play-button" type="button" aria-label="Phát video">▶</button><IconButton icon="↦" label="Phân đoạn tiếp theo" /></div><div className="transport-actions"><IconButton icon="♩" label="Âm lượng" /><span>1.0x</span><IconButton icon="⚙" label="Cài đặt player" /><IconButton icon="⛶" label="Toàn màn hình" /></div></div></section>;
}
