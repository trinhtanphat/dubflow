import type { Speaker } from './types';

function deterministicWave(seed: number) {
  return Array.from({ length: 100 }, (_, index) => 9 + ((index * 17 + seed * 23 + (index % 7) * 9) % 32));
}

export function WaveformTrack({ speaker, index }: { speaker: Speaker; index: number }) {
  return <div className={`waveform wave-${speaker.accent}`}>{deterministicWave(index).map((height, itemIndex) => <i key={itemIndex} style={{ height }} />)}</div>;
}
