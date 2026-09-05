export const SOURCE_LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko'] as const;
export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];

export type ProjectRow = {
  id: string;
  user_id: string;
  title: string;
  source_language: SourceLanguage;
  target_language: 'vi';
  status: string;
  source_object_key: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
};
