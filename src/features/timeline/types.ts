export type Speaker = {
  id: string;
  name: string;
  gender: 'Nữ' | 'Nam';
  share: number;
  accent: 'violet' | 'blue' | 'green';
  initials: string;
};

export type Segment = {
  id: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
};

export type StudioProject = {
  title: string;
  sourceLanguage: 'zh';
  targetLanguage: 'vi';
  durationMs: number;
  speakers: Speaker[];
  segments: Segment[];
};
