export type StreamVideoStatus = {
  state?: string;
  errorReasonCode?: string;
  errorReasonText?: string;
};

export type StreamVideoLike = {
  id: string;
  readyToStream?: boolean;
  readyToStreamAt?: string | null;
  duration?: number;
  status?: StreamVideoStatus;
};

export type StreamDownloadVariant = {
  status?: string;
  percentComplete?: number;
  url?: string;
};

export type StreamDownloadResponseLike = {
  default?: StreamDownloadVariant;
  audio?: StreamDownloadVariant;
};

export interface StreamDownloadsLike {
  generate(type?: 'default' | 'audio'): Promise<unknown>;
  get(): Promise<StreamDownloadResponseLike>;
}

export interface StreamVideoHandleLike {
  details(): Promise<StreamVideoLike>;
  downloads: StreamDownloadsLike;
}

export interface StreamBindingLike {
  upload(url: string, params?: Record<string, unknown>): Promise<StreamVideoLike>;
  video(id: string): StreamVideoHandleLike;
}
