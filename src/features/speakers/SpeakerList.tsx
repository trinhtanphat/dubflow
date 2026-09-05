import { Panel } from '../../components/ui/Panel';
import type { Speaker } from '../timeline/types';

type SpeakerListProps = { speakers: Speaker[]; selectedSpeakerId?: string };
function miniWave(seed: number) { return Array.from({ length: 18 }, (_, index) => 24 + ((index * 23 + seed * 19) % 70)); }
export function SpeakerList({ speakers, selectedSpeakerId }: SpeakerListProps) {
  return <Panel title={`Nhân vật đã nhận diện (${speakers.length})`}><div className="speaker-list">{speakers.map((speaker, index) => <article className={`speaker-card ${speaker.id === selectedSpeakerId ? 'is-active' : ''}`} key={speaker.id}><div className={`speaker-avatar speaker-avatar--${index + 1}`}>{speaker.name.slice(0, 1)}</div><div className="speaker-card__body"><strong>{speaker.name}</strong><span>{speaker.label} · {speaker.share}% thời lượng</span><div className="mini-wave" aria-hidden="true">{miniWave(index + 1).map((height, bar) => <i key={bar} style={{ height: `${height}%` }} />)}</div></div><span className="speaker-chevron">⌄</span></article>)}</div></Panel>;
}
