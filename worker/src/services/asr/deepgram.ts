import type { AsrChunkResult, AsrContext, AsrProvider, AsrSegment } from './types';
import { AsrError } from './types';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type RawUtterance = {
  start?: number;
  end?: number;
  transcript?: string;
  speaker?: number;
};

type RawResponse = {
  results?: {
    channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    utterances?: RawUtterance[];
  };
};

export class DeepgramNova3AsrProvider implements AsrProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async transcribe(audio: ArrayBuffer, context: AsrContext): Promise<AsrChunkResult> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) throw new AsrError('ASR_PROVIDER_UNCONFIGURED', 'Deepgram API key is required for diarized ASR.');

    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('model', 'nova-3');
    url.searchParams.set('diarize_model', 'latest');
    url.searchParams.set('utterances', 'true');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('punctuate', 'true');
    if (context.sourceLanguage !== 'auto') url.searchParams.set('language', context.sourceLanguage);

    const response = await this.fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'content-type': 'audio/wav',
      },
      body: audio,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new AsrError(
        'ASR_PROVIDER_FAILED',
        `Deepgram Nova-3 transcription failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`,
      );
    }

    const payload = await response.json() as RawResponse;
    const utterances = payload.results?.utterances;
    if (!Array.isArray(utterances)) {
      throw new AsrError('ASR_RESPONSE_INVALID', 'Deepgram Nova-3 returned no utterance list.');
    }

    const segments: AsrSegment[] = utterances.map((utterance, index) => {
      if (typeof utterance.start !== 'number'
        || typeof utterance.end !== 'number'
        || typeof utterance.transcript !== 'string'
        || !Number.isInteger(utterance.speaker)
        || (utterance.speaker as number) < 0) {
        throw new AsrError('ASR_RESPONSE_INVALID', `Deepgram Nova-3 returned malformed utterance ${index}.`);
      }
      const startMs = Math.round(utterance.start * 1000);
      const endMs = Math.round(utterance.end * 1000);
      if (endMs <= startMs) throw new AsrError('ASR_RANGE_INVALID', 'ASR utterance end must be after start.');
      return {
        startMs,
        endMs,
        text: utterance.transcript.trim(),
        speakerIndex: utterance.speaker as number,
      };
    });

    const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    return {
      text: typeof transcript === 'string' ? transcript : segments.map((segment) => segment.text).join(' '),
      segments,
    };
  }
}
