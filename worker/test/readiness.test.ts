import { describe, expect, it } from 'vitest';
import { checkReadiness } from '../src/routes/readiness';

describe('checkReadiness', () => {
  it('reports ready and configured chunk-scoped diarization after the projects schema exists', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return { name: 'projects' } as T;
          },
        };
      },
    };

    await expect(checkReadiness(db, ' dg-secret ')).resolves.toEqual({
      ready: true,
      service: 'dubflow',
      database: 'ready',
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
    });
  });

  it('keeps the service ready on the Workers AI fallback but reports diarization unavailable', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return { name: 'projects' } as T;
          },
        };
      },
    };

    await expect(checkReadiness(db)).resolves.toEqual({
      ready: true,
      service: 'dubflow',
      database: 'ready',
      asr: {
        provider: 'workers-ai-whisper-large-v3-turbo',
        speakerDiarization: 'unavailable',
        speakerIdentityScope: 'none',
      },
    });
  });

  it('fails closed before migrations create the projects table while still reporting ASR capability truthfully', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            return null as T | null;
          },
        };
      },
    };

    await expect(checkReadiness(db, 'dg-secret')).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'missing-schema',
      asr: {
        provider: 'deepgram-nova-3',
        speakerDiarization: 'configured',
        speakerIdentityScope: 'chunk',
      },
    });
  });

  it('fails closed when D1 is unavailable while still reporting the fallback capability', async () => {
    const db = {
      prepare() {
        return {
          async first<T>() {
            throw new Error('D1 unavailable');
          },
        };
      },
    };

    await expect(checkReadiness(db)).resolves.toEqual({
      ready: false,
      service: 'dubflow',
      database: 'unavailable',
      asr: {
        provider: 'workers-ai-whisper-large-v3-turbo',
        speakerDiarization: 'unavailable',
        speakerIdentityScope: 'none',
      },
    });
  });
});
