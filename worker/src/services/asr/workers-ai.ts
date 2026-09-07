import type { AiBinding } from '../../cloudflare/ai';
import type { AsrChunkResult, AsrContext, AsrProvider } from './types';
import { AsrError } from './types';

export const WORKERS_AI_ASR_MODEL = '@cf/openai/whisper-large-v3-turbo';

const DEFAULT_DIRECT_SOURCE_MEDIA_TYPE = 'video/mp4';
const BASE64_CHUNK_BYTES = 24_576;

type RawSegment = { start?: number; end?: number; text?: string };
type RawResponse = { text?: string; segments?: RawSegment[] };

function arrayBufferToBase64(audio: ArrayBuffer): string {
  const bytes = new Uint8Array(audio);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_CHUNK_BYTES, bytes.length);
    let binary = '';
    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    parts.push(btoa(binary));
  }
  return parts.join('');
}

function mediaInput(audio: ArrayBuffer, mediaType?: string) {
  return {
    body: arrayBufferToBase64(audio),
    contentType: mediaType?.trim() || DEFAULT_DIRECT_SOURCE_MEDIA_TYPE,
  };
}

export class WorkersAIAsrProvider implements AsrProvider {
  constructor(private readonly ai: AiBinding) {}

  async transcribe(audio: ArrayBuffer, context: AsrContext): Promise<AsrChunkResult> {
    const input: Record<string, unknown> = {
      audio: mediaInput(audio, context.mediaType),
      task: 'transcribe',
      vad_filter: true,
    };
    if (context.sourceLanguage !== 'auto') input.language = context.sourceLanguage;
    const response = await this.ai.run(WORKERS_AI_ASR_MODEL, input) as RawResponse;
    const rawSegments = Array.isArray(response?.segments) ? response.segments : [];
    const segments = rawSegments.map((segment) => {
      if (typeof segment.start !== 'number' || typeof segment.end !== 'number' || typeof segment.text !== 'string') {
        throw new AsrError('ASR_RESPONSE_INVALID', 'Workers AI ASR returned a malformed segment.');
      }
      const startMs = Math.round(segment.start * 1000);
      const endMs = Math.round(segment.end * 1000);
      if (endMs <= startMs) throw new AsrError('ASR_RANGE_INVALID', 'ASR segment end must be after start.');
      return { startMs, endMs, text: segment.text.trim() };
    });
    return { text: typeof response?.text === 'string' ? response.text : segments.map((s) => s.text).join(' '), segments };
  }
}
