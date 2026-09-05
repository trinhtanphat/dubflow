import type { SourceLanguage } from '../../domain/project';

export type AsrSegment = {
  startMs: number;
  endMs: number;
  text: string;
  speakerIndex?: number;
};
export type AsrChunkResult = { text: string; segments: AsrSegment[] };
export type AsrContext = { sourceLanguage: SourceLanguage };

export interface AsrProvider {
  transcribe(audio: ArrayBuffer, context: AsrContext): Promise<AsrChunkResult>;
}

export class AsrError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AsrError';
  }
}
