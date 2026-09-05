export type Speaker = { id: string; name: string; label: string; share: number };
export type Segment = { id: string; speakerId: string; startMs: number; endMs: number; sourceText: string; translatedText: string };
export type StudioProject = {
  id: string;
  title: string;
  durationMs: number;
  sourceLanguage: 'auto'|'zh'|'en'|'ja'|'ko';
  targetLanguage: 'vi';
  speakers: Speaker[];
  segments: Segment[];
  sourceObjectKey?: string | null;
  exportObjectKey?: string | null;
  status?: string;
  frameRate?: number | null;
};
