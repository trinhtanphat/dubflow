import { ChevronDown, Plus } from 'lucide-react';
import type { Speaker } from '../timeline/types';

function bars(seed: number) {
  return Array.from({ length: 21 }, (_, index) => 5 + ((index * 11 + seed * 7) % 18));
}

export function SpeakerList({ speakers }: { speakers: Speaker[] }) {
  return (
    <section className="speaker-section">
      <div className="rail-title-row"><div className="rail-heading">Nhân vật đã nhận diện <span>({speakers.length})</span></div><div className="speaker-tools"><button type="button">Tự động</button><button className="add-speaker" type="button" aria-label="Thêm nhân vật"><Plus size={14}/></button></div></div>
      <div className="speaker-list">
        {speakers.map((speaker, speakerIndex) => (
          <div className="speaker-card" key={speaker.id}>
            <div className={`avatar avatar-${speaker.accent}`}><span>{speaker.initials}</span></div>
            <div className="speaker-meta"><strong>{speaker.roleZh} - {speaker.name}</strong><span>{speaker.gender} · {speaker.share}% thời lượng</span></div>
            <div className={`mini-wave wave-${speaker.accent}`}>{bars(speakerIndex).map((height, index) => <i key={index} style={{ height }} />)}</div>
            <ChevronDown size={15} className="speaker-chevron" />
          </div>
        ))}
      </div>
    </section>
  );
}
