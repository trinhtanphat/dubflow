export type LipSyncInput = {
  videoUrl: string;
  audioUrl: string;
};

export type LipSyncResult = {
  provider: string;
  providerJobId: string;
  outputUrl: string;
  outputDurationSeconds?: number;
};

export interface LipSyncProvider {
  readonly id: string;
  readonly available: boolean;
  render(input: LipSyncInput): Promise<LipSyncResult>;
}

export type LipSyncErrorCode =
  | 'LIP_SYNC_UNAVAILABLE'
  | 'LIP_SYNC_FAILED'
  | 'LIP_SYNC_TIMEOUT'
  | 'LIP_SYNC_RESPONSE_INVALID';

export class LipSyncProviderError extends Error {
  constructor(public readonly code: LipSyncErrorCode, message: string) {
    super(message);
    this.name = 'LipSyncProviderError';
  }
}
