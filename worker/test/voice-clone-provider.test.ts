import { describe, expect, it, vi } from 'vitest';
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
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = new ElevenLabsVoiceCloneProvider('secret-key', fetcher);

    await provider.deleteClone('voice/with spaces');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.elevenlabs.io/v1/voices/voice%2Fwith%20spaces');
    expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE');
  });
});
