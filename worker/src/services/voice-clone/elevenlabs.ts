import {
  VoiceCloneProviderError,
  type CreateInstantCloneInput,
  type CreateInstantCloneResult,
  type VoiceCloneProvider,
} from './types';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ElevenLabsVoiceCloneProvider implements VoiceCloneProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  private key(): string {
    const value = this.apiKey.trim();
    if (!value) {
      throw new VoiceCloneProviderError('VOICE_CLONE_PROVIDER_UNCONFIGURED', 'Voice clone provider is not configured.');
    }
    return value;
  }

  async createInstantClone(input: CreateInstantCloneInput): Promise<CreateInstantCloneResult> {
    const form = new FormData();
    form.set('name', input.name.trim());
    form.append('files', input.sample, 'voice-sample');

    const response = await this.fetcher('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': this.key() },
      body: form,
    });
    if (!response.ok) {
      throw new VoiceCloneProviderError('VOICE_CLONE_PROVIDER_FAILED', 'Voice clone provider rejected enrollment.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VoiceCloneProviderError('VOICE_CLONE_PROVIDER_FAILED', 'Voice clone provider returned an invalid response.');
    }
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const providerVoiceId = typeof data.voice_id === 'string' ? data.voice_id.trim() : '';
    if (!providerVoiceId) {
      throw new VoiceCloneProviderError('VOICE_CLONE_PROVIDER_FAILED', 'Voice clone provider returned no voice identifier.');
    }
    return {
      providerVoiceId,
      // Only an explicit provider `false` is eligible for ready state. Missing or
      // malformed verification metadata stays fail-closed and non-assignable.
      requiresVerification: data.requires_verification !== false,
    };
  }

  async deleteClone(providerVoiceId: string): Promise<void> {
    const id = providerVoiceId.trim();
    if (!id) throw new VoiceCloneProviderError('VOICE_CLONE_DELETE_FAILED', 'Voice clone identifier is required.');
    const response = await this.fetcher(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': this.key() },
    });
    if (!response.ok) {
      throw new VoiceCloneProviderError('VOICE_CLONE_DELETE_FAILED', 'Voice clone provider deletion failed.');
    }
  }
}
