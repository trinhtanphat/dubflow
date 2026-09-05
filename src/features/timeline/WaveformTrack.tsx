import type { Speaker } from './types';
type WaveformTrackProps = { speaker: Speaker; index: number };
export function WaveformTrack({ speaker, index }: WaveformTrackProps) {
  const bars = Array.from({ length: 96 }, (_, i) => 14 + ((i * 29 + (index + 1) * 31) % 80));
  return <div className={`timeline-row waveform-row waveform-row--${index + 1}`}><div className="track-label"><span className="track-person">◉</span>{speaker.name}</div><div className="track-content waveform-content" aria-label={`Waveform ${speaker.name}`}>{bars.map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div></div>;
}
