import { useState } from 'react';
import { Panel } from '../../components/ui/Panel';
import type { Speaker } from '../timeline/types';
import { updateSpeaker } from './speakerApi';

type SpeakerListProps = { speakers: Speaker[]; selectedSpeakerId?: string };

function miniWave(seed: number) {
  return Array.from({ length: 18 }, (_, index) => 24 + ((index * 23 + seed * 19) % 70));
}

function SpeakerCard({ speaker, index, selected }: { speaker: Speaker; index: number; selected: boolean }) {
  const [displayName, setDisplayName] = useState(speaker.name);
  const [voiceId, setVoiceId] = useState(speaker.voiceId ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const save = async () => {
    if (!speaker.projectId || !displayName.trim() || saving) return;
    setSaving(true);
    setMessage('');
    try {
      const updated = await updateSpeaker(speaker.projectId, speaker.id, {
        displayName: displayName.trim(),
        voiceId: voiceId.trim() || null,
      });
      setDisplayName(updated.displayName);
      setVoiceId(updated.voiceId ?? '');
      setMessage(updated.voiceId ? 'Đã lưu giọng ElevenLabs.' : 'Đã bỏ gán giọng riêng.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể lưu giọng nhân vật.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className={`speaker-card ${selected ? 'is-active' : ''}`}>
      <div className={`speaker-avatar speaker-avatar--${index + 1}`}>{displayName.slice(0, 1)}</div>
      <div className="speaker-card__body">
        <strong>{displayName}</strong>
        <span>{speaker.label} · {speaker.share}% thời lượng</span>
        <div className="mini-wave" aria-hidden="true">
          {miniWave(index + 1).map((height, bar) => <i key={bar} style={{ height: `${height}%` }} />)}
        </div>
        {selected && speaker.projectId && (
          <div className="speaker-voice-editor">
            <input
              aria-label="Tên nhân vật"
              value={displayName}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <input
              aria-label="ElevenLabs voice ID"
              value={voiceId}
              maxLength={200}
              placeholder="voice ID · để trống dùng giọng mặc định"
              onChange={(event) => setVoiceId(event.target.value)}
            />
            <button
              className="secondary-button"
              type="button"
              disabled={saving || !displayName.trim()}
              onClick={() => { void save(); }}
            >{saving ? 'Đang lưu…' : 'Lưu giọng nhân vật'}</button>
            {message && <small role="status">{message}</small>}
          </div>
        )}
      </div>
      <span className="speaker-chevron">⌄</span>
    </article>
  );
}

export function SpeakerList({ speakers, selectedSpeakerId }: SpeakerListProps) {
  return (
    <Panel title={`Nhân vật đã nhận diện (${speakers.length})`}>
      <div className="speaker-list">
        {speakers.map((speaker, index) => (
          <SpeakerCard
            key={speaker.id}
            speaker={speaker}
            index={index}
            selected={speaker.id === selectedSpeakerId}
          />
        ))}
      </div>
    </Panel>
  );
}
