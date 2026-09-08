import { describe, expect, it, vi } from 'vitest';
import {
  LocalInferenceCoordinatorError,
  runBrowserLocalInference,
} from './localInferenceCoordinator';
import {
  BROWSER_LOCAL_ASR,
  BROWSER_LOCAL_TRANSLATION,
  type CloudProject,
} from '../projects/projectApi';

const project: CloudProject = {
  id: 'p1',
  userId: 'u1',
  title: 'Project',
  sourceLanguage: 'en',
  targetLanguage: 'vi',
  status: 'needs_review',
  sourceGeneration: 3,
  sourceObjectKey: 'projects/p1/source/current.mp4',
  durationMs: 60_000,
  sizeBytes: 1024,
};

const variants = [{
  segmentId: 'existing',
  speakerId: 'browser-local:p1:speaker-1',
  startMs: 0,
  endMs: 1_000,
  sourceText: 'Hello',
  translation: {
    translatedText: 'Xin chào',
    translationEngine: 'browser-opus-mt',
    translationStatus: 'completed',
  },
}] as any;

function matchingState() {
  return {
    sourceGeneration: 3,
    sourceObjectKey: 'projects/p1/source/current.mp4',
    asr: BROWSER_LOCAL_ASR,
    translation: BROWSER_LOCAL_TRANSLATION,
  };
}

function projectWithState(state: ReturnType<typeof matchingState> | null): CloudProject {
  return { ...project, clientInferenceState: state };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    getProject: vi.fn(async () => projectWithState(matchingState())),
    getTranslationVariants: vi.fn(async () => variants),
    fetchSourceMedia: vi.fn(async () => new File([new Uint8Array([1])], 'source.mp4')),
    decodeSourceAudio: vi.fn(async () => ({
      pcm: new Float32Array(60_000 * 16),
      sampleRate: 16_000,
      durationMs: 60_000,
    })),
    createAsrClient: vi.fn(() => ({
      transcribe: vi.fn(async () => [{ text: 'Hello', startMs: 0, endMs: 1_000 }]),
      shutdown: vi.fn(async () => undefined),
    })),
    createTranslationClient: vi.fn(() => ({
      translate: vi.fn(async () => 'Xin chào'),
      shutdown: vi.fn(async () => undefined),
    })),
    commitClientInference: vi.fn(async () => ({})),
    createId: vi.fn(() => crypto.randomUUID()),
    ...overrides,
  } as any;
}

describe('browser-local coordinator hardening', () => {
  it('resumes only when durable inference state matches the exact current source and model revisions', async () => {
    const exact = dependencies();
    await expect(runBrowserLocalInference('p1', { dependencies: exact })).resolves.toMatchObject({ resumed: true });
    expect(exact.fetchSourceMedia).not.toHaveBeenCalled();

    const staleFetch = vi.fn(async () => { throw new Error('stale artifacts must not resume'); });
    const stale = dependencies({
      getProject: vi.fn(async () => projectWithState({ ...matchingState(), sourceGeneration: 2 })),
      fetchSourceMedia: staleFetch,
    });
    await expect(runBrowserLocalInference('p1', { dependencies: stale })).rejects.toThrow('stale artifacts must not resume');
    expect(staleFetch).toHaveBeenCalledTimes(1);

    const missingFetch = vi.fn(async () => { throw new Error('missing state must not resume'); });
    const missing = dependencies({
      getProject: vi.fn(async () => projectWithState(null)),
      fetchSourceMedia: missingFetch,
    });
    await expect(runBrowserLocalInference('p1', { dependencies: missing })).rejects.toThrow('missing state must not resume');
    expect(missingFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of silently truncating ASR output above the 500 segment limit', async () => {
    const asrSegments = Array.from({ length: 501 }, (_, index) => ({
      text: `segment ${index}`,
      startMs: index * 100,
      endMs: (index + 1) * 100,
    }));
    const commit = vi.fn(async () => ({}));
    const deps = dependencies({
      getTranslationVariants: vi.fn(async () => []),
      createAsrClient: vi.fn(() => ({
        transcribe: vi.fn(async () => asrSegments),
        shutdown: vi.fn(async () => undefined),
      })),
      commitClientInference: commit,
    });

    await expect(runBrowserLocalInference('p1', { dependencies: deps })).rejects.toMatchObject({
      code: 'LOCAL_ASR_INVALID',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects duplicate locally generated segment ids before any durable commit', async () => {
    const commit = vi.fn(async () => ({}));
    const deps = dependencies({
      getTranslationVariants: vi.fn(async () => []),
      createAsrClient: vi.fn(() => ({
        transcribe: vi.fn(async () => [
          { text: 'one', startMs: 0, endMs: 500 },
          { text: 'two', startMs: 500, endMs: 1_000 },
        ]),
        shutdown: vi.fn(async () => undefined),
      })),
      createId: vi.fn(() => 'duplicate-id'),
      commitClientInference: commit,
    });

    await expect(runBrowserLocalInference('p1', { dependencies: deps })).rejects.toBeInstanceOf(LocalInferenceCoordinatorError);
    expect(commit).not.toHaveBeenCalled();
  });
});
