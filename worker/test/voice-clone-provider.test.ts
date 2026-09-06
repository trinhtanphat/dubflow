import { describe, expect, it } from 'vitest';
import { ElevenLabsVoiceCloneProvider } from '../src/services/voice-clone/elevenlabs';

describe('ElevenLabs managed voice clone provider', () => {
  it('creates an IVC with a bounded multipart name and sample', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new ElevenLabsVoiceCloneProvider('secret-key', async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({ voice_id: 'voice-123', requires_verification: true });
    });

    const result = await provider.createInstantClone({
      name: 'Narrator',
      sample: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
    });

    expect(result).toEqual({ providerVoiceId: 'voice-123', requiresVerification: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/voices/add');
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('xi-api-key')).toBe('secret-key');
    const form = calls[0].init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('name')).toBe('Narrator');
    const file = form.get('files');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).size).toBe(3);
  });

  it('fails closed to verification-required unless the provider explicitly returns false', async () => {
    const missingFlag = new ElevenLabsVoiceCloneProvider('secret-key', async () => Response.json({ voice_id: 'voice-missing' }));
    const malformedFlag = new ElevenLabsVoiceCloneProvider('secret-key', async () => Response.json({ voice_id: 'voice-malformed', requires_verification: 'false' }));
    const explicitFalse = new ElevenLabsVoiceCloneProvider('secret-key', async () => Response.json({ voice_id: 'voice-ready', requires_verification: false }));

    await expect(missingFlag.createInstantClone({
      name: 'Missing',
      sample: new Blob(['audio'], { type: 'audio/mpeg' }),
    })).resolves.toEqual({ providerVoiceId: 'voice-missing', requiresVerification: true });
    await expect(malformedFlag.createInstantClone({
      name: 'Malformed',
      sample: new Blob(['audio'], { type: 'audio/mpeg' }),
    })).resolves.toEqual({ providerVoiceId: 'voice-malformed', requiresVerification: true });
    await expect(explicitFalse.createInstantClone({
      name: 'Ready',
      sample: new Blob(['audio'], { type: 'audio/mpeg' }),
    })).resolves.toEqual({ providerVoiceId: 'voice-ready', requiresVerification: false });
  });

  it('does not surface raw provider failure bodies', async () => {
    const provider = new ElevenLabsVoiceCloneProvider('secret-key', async () => new Response(
      'sensitive provider body secret-token',
      { status: 422 },
    ));

    await expect(provider.createInstantClone({
      name: 'Narrator',
      sample: new Blob(['audio'], { type: 'audio/mpeg' }),
    })).rejects.toMatchObject({ code: 'VOICE_CLONE_PROVIDER_FAILED' });

    try {
      await provider.createInstantClone({
        name: 'Narrator',
        sample: new Blob(['audio'], { type: 'audio/mpeg' }),
      });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-token');
      expect(String((error as Error).message)).not.toContain('sensitive provider body');
    }
  });

  it('deletes the exact encoded provider voice id', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      return new Response(null, { status: 204 });
    };
    const provider = new ElevenLabsVoiceCloneProvider('secret-key', fetcher);

    await provider.deleteClone('voice/with spaces');

    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe('https://api.elevenlabs.io/v1/voices/voice%2Fwith%20spaces');
    expect(calls[0].init?.method).toBe('DELETE');
  });
});