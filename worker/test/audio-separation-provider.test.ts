import { describe, expect, it } from 'vitest';
import { ContainerAudioSeparationProvider } from '../src/services/separation/container';

const identity = {
  provider: 'demucs-container',
  modelId: 'htdemucs',
  modelDigest: 'sha256:8726e21a',
  qualified: false,
};

describe('ContainerAudioSeparationProvider', () => {
  it('keeps capability identity explicit and unqualified by default', async () => {
    const provider = new ContainerAudioSeparationProvider({ getByName() { throw new Error('unused'); } }, identity);
    await expect(provider.capabilities()).resolves.toEqual({
      configured: true,
      qualified: false,
      provider: 'demucs-container',
      modelId: 'htdemucs',
      modelDigest: 'sha256:8726e21a',
    });
  });

  it('derives canonical project/source/model stem keys and validates the container response', async () => {
    let request: Request | null = null;
    const provider = new ContainerAudioSeparationProvider({
      getByName(name: string) {
        expect(name).toBe('project-1');
        return {
          async fetch(input: Request) {
            request = input;
            return Response.json({
              dialogueObjectKey: 'projects/project-1/separation/3/demucs-container/sha256-8726e21a/dialogue.wav',
              backgroundObjectKey: 'projects/project-1/separation/3/demucs-container/sha256-8726e21a/background.wav',
              durationMs: 123000,
            });
          },
        };
      },
    }, identity);

    await expect(provider.separate({
      projectId: 'project-1',
      sourceObjectKey: 'projects/project-1/source/source.mp4',
      sourceRevision: 3,
      provider: identity.provider,
      modelId: identity.modelId,
      modelDigest: identity.modelDigest,
    })).resolves.toEqual({
      dialogueObjectKey: 'projects/project-1/separation/3/demucs-container/sha256-8726e21a/dialogue.wav',
      backgroundObjectKey: 'projects/project-1/separation/3/demucs-container/sha256-8726e21a/background.wav',
      durationMs: 123000,
    });

    expect(request).not.toBeNull();
    expect(new URL(request!.url).pathname).toBe('/separate');
    expect(await request!.json()).toMatchObject({
      projectId: 'project-1',
      sourceObjectKey: 'projects/project-1/source/source.mp4',
      sourceRevision: 3,
      provider: 'demucs-container',
      modelId: 'htdemucs',
      modelDigest: 'sha256:8726e21a',
      dialogueObjectKey: 'projects/project-1/separation/3/demucs-container/sha256-8726e21a/dialogue.wav',
      backgroundObjectKey: 'projects/project-1/separation/3/demucs-container/sha256-8726e21a/background.wav',
    });
  });

  it('rejects cross-project or unexpected stem keys returned by the container', async () => {
    const provider = new ContainerAudioSeparationProvider({
      getByName() {
        return { async fetch() { return Response.json({
          dialogueObjectKey: 'projects/other/separation/3/demucs-container/sha256-8726e21a/dialogue.wav',
          backgroundObjectKey: 'projects/project-1/separation/3/demucs-container/sha256-8726e21a/background.wav',
          durationMs: 1000,
        }); } };
      },
    }, identity);

    await expect(provider.separate({
      projectId: 'project-1', sourceObjectKey: 'projects/project-1/source/source.mp4', sourceRevision: 3,
      provider: identity.provider, modelId: identity.modelId, modelDigest: identity.modelDigest,
    })).rejects.toMatchObject({ code: 'SEPARATION_RESPONSE_INVALID' });
  });
});
