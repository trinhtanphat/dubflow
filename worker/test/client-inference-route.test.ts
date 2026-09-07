import { describe, expect, it } from 'vitest';
import {
  LOCAL_INFERENCE_ASR,
  LOCAL_INFERENCE_TRANSLATION,
  LocalInferenceInputError,
  normalizeClientInferenceInput,
} from '../src/domain/client-inference';

function validPayload() {
  return {
    sourceGeneration: 3,
    sourceObjectKey: 'projects/p1/source/current.mp4',
    durationMs: 4_000,
    asr: { ...LOCAL_INFERENCE_ASR },
    translation: { ...LOCAL_INFERENCE_TRANSLATION },
    segments: [
      { id: 's1', startMs: 0, endMs: 1_500, sourceText: ' Hello ' },
      { id: 's2', startMs: 1_500, endMs: 4_000, sourceText: 'world' },
    ],
    translations: [
      { segmentId: 's1', translatedText: ' Xin chào ' },
      { segmentId: 's2', translatedText: 'thế giới' },
    ],
  };
}

describe('browser-local client inference request validation', () => {
  it('normalizes the exact approved EN→VI local inference payload', () => {
    const input = normalizeClientInferenceInput('p1', validPayload());
    expect(input.sourceGeneration).toBe(3);
    expect(input.sourceObjectKey).toBe('projects/p1/source/current.mp4');
    expect(input.durationMs).toBe(4_000);
    expect(input.asr).toEqual(LOCAL_INFERENCE_ASR);
    expect(input.translation).toEqual(LOCAL_INFERENCE_TRANSLATION);
    expect(input.segments).toEqual([
      { id: 's1', startMs: 0, endMs: 1_500, sourceText: 'Hello' },
      { id: 's2', startMs: 1_500, endMs: 4_000, sourceText: 'world' },
    ]);
    expect(input.translations).toEqual([
      { segmentId: 's1', translatedText: 'Xin chào' },
      { segmentId: 's2', translatedText: 'thế giới' },
    ]);
  });

  it('rejects malformed source identity, duration and model provenance', () => {
    expect(() => normalizeClientInferenceInput('p1', { ...validPayload(), sourceGeneration: 0 }))
      .toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', { ...validPayload(), sourceObjectKey: '   ' }))
      .toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', { ...validPayload(), durationMs: 300_001 }))
      .toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', {
      ...validPayload(),
      asr: { ...LOCAL_INFERENCE_ASR, revision: 'wrong' },
    })).toThrow(LocalInferenceInputError);
    expect(() => normalizeClientInferenceInput('p1', {
      ...validPayload(),
      translation: { ...LOCAL_INFERENCE_TRANSLATION, provider: 'workers-ai' },
    })).toThrow(LocalInferenceInputError);
  });

  it('rejects client speaker injection, short/overlapping/out-of-bounds or empty ASR segments', () => {
    const speaker = validPayload();
    speaker.segments = [{ ...speaker.segments[0], speakerId: 'attacker-speaker' } as never];
    speaker.translations = [{ segmentId: 's1', translatedText: 'Xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', speaker)).toThrow(LocalInferenceInputError);

    const short = validPayload();
    short.segments = [{ id: 's1', startMs: 0, endMs: 99, sourceText: 'hello' }];
    short.translations = [{ segmentId: 's1', translatedText: 'xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', short)).toThrow(LocalInferenceInputError);

    const overlap = validPayload();
    overlap.segments = [
      { id: 's1', startMs: 0, endMs: 2_000, sourceText: 'hello' },
      { id: 's2', startMs: 1_999, endMs: 4_000, sourceText: 'world' },
    ];
    expect(() => normalizeClientInferenceInput('p1', overlap)).toThrow(LocalInferenceInputError);

    const outOfBounds = validPayload();
    outOfBounds.segments = [{ id: 's1', startMs: 0, endMs: 4_001, sourceText: 'hello' }];
    outOfBounds.translations = [{ segmentId: 's1', translatedText: 'xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', outOfBounds)).toThrow(LocalInferenceInputError);

    const empty = validPayload();
    empty.segments = [];
    empty.translations = [];
    expect(() => normalizeClientInferenceInput('p1', empty)).toThrow(LocalInferenceInputError);
  });

  it('requires exactly one nonempty translation for every canonical segment', () => {
    const missing = validPayload();
    missing.translations = [{ segmentId: 's1', translatedText: 'xin chào' }];
    expect(() => normalizeClientInferenceInput('p1', missing)).toThrow(LocalInferenceInputError);

    const duplicate = validPayload();
    duplicate.translations = [
      { segmentId: 's1', translatedText: 'xin chào' },
      { segmentId: 's1', translatedText: 'lặp' },
    ];
    expect(() => normalizeClientInferenceInput('p1', duplicate)).toThrow(LocalInferenceInputError);

    const unknown = validPayload();
    unknown.translations = [
      { segmentId: 's1', translatedText: 'xin chào' },
      { segmentId: 'other', translatedText: 'khác' },
    ];
    expect(() => normalizeClientInferenceInput('p1', unknown)).toThrow(LocalInferenceInputError);

    const blank = validPayload();
    blank.translations[1].translatedText = '   ';
    expect(() => normalizeClientInferenceInput('p1', blank)).toThrow(LocalInferenceInputError);
  });
});
