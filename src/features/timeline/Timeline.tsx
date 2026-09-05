import { Captions, Film, Mic2 } from 'lucide-react';
import type { Segment, Speaker } from './types';
import { TimelineTrack } from './TimelineTrack';
import { SegmentBlock } from './SegmentBlock';
import { WaveformTrack } from './WaveformTrack';
import { timeToPercent } from './math';

type Props = { durationMs: number; playheadMs: number; speakers: Speaker[]; segments: Segment[]; selectedId: string; onSelect: (id: string) => void };

export function Timeline({ durationMs, playheadMs, speakers, segments, selectedId, onSelect }: Props) {
  const previewDuration = 50_000;
  const visibleSegments = segments;
  const markers = ['00:00', '00:10:00', '00:20:00', '00:30:00', '00:40:00'];
  const scaledPlayhead = timeToPercent(Math.min(playheadMs % previewDuration, previewDuration), previewDuration);
  return (
    <section className="timeline" aria-label="Timeline đa track">
      <div className="timeline-ruler"><div className="ruler-label"/><div className="ruler-scale">{markers.map((label) => <span key={label}>{label}</span>)}</div></div>
      <div className="timeline-body">
        <div className="global-playhead" style={{ left: `calc(116px + (100% - 116px) * ${scaledPlayhead / 100})` }}><b/></div>
        <TimelineTrack label={<><Film size={16}/> Video</>}><div className="thumb-strip">{Array.from({ length: 10 }, (_, index) => <img key={index} src="/demo-frame.svg" alt="" />)}</div></TimelineTrack>
        <TimelineTrack label={<><Captions size={16}/> Phụ đề gốc<small>中文</small></>}><div className="segment-layer">{visibleSegments.map((segment) => <SegmentBlock key={segment.id} segment={segment} durationMs={previewDuration} selected={segment.id === selectedId} text={segment.sourceText} className="source-segment" onSelect={() => onSelect(segment.id)} />)}</div></TimelineTrack>
        <TimelineTrack label={<><Captions size={16}/> Dịch & phụ đề<small>Tiếng Việt</small></>}><div className="segment-layer">{visibleSegments.map((segment) => <SegmentBlock key={segment.id} segment={segment} durationMs={previewDuration} selected={segment.id === selectedId} text={segment.translatedText} className="translated-segment" onSelect={() => onSelect(segment.id)} />)}</div></TimelineTrack>
        {speakers.map((speaker, index) => <TimelineTrack key={speaker.id} label={<><Mic2 size={16} className={`label-${speaker.accent}`}/><span>{speaker.name} <small>({speaker.gender})</small></span></>}><WaveformTrack speaker={speaker} index={index}/></TimelineTrack>)}
      </div>
    </section>
  );
}
