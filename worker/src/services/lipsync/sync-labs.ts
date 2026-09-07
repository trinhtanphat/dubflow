import {
  LipSyncProviderError,
  type LipSyncInput,
  type LipSyncProvider,
  type LipSyncResult,
} from './types';

const SYNC_BASE_URL = 'https://api.sync.so';
const SYNC_MODEL = 'sync-3';
const DEFAULT_MAX_POLL_ATTEMPTS = 6;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

type SyncLabsOptions = {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  maxPollAttempts?: number;
  requestTimeoutMs?: number;
};

type SyncJobResponse = {
  id?: unknown;
  status?: unknown;
  outputUrl?: unknown;
  outputDuration?: unknown;
};

type SyncJobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REJECTED';

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function httpsUrl(value: string, label: string): string {
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', `${label} must be an HTTPS URL.`);
  }
  if (url.protocol !== 'https:' || !url.hostname) {
    throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', `${label} must be an HTTPS URL.`);
  }
  return url.toString();
}

function responseStatus(value: unknown): SyncJobStatus {
  if (typeof value !== 'string') {
    throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider returned an invalid status.');
  }
  const normalized = value.toUpperCase();
  if (!['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED'].includes(normalized)) {
    throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider returned an invalid status.');
  }
  return normalized as SyncJobStatus;
}

function responseJobId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider returned an invalid job id.');
  }
  return value.trim();
}

function completedResult(job: SyncJobResponse, providerJobId: string): LipSyncResult {
  if (typeof job.outputUrl !== 'string' || !job.outputUrl.trim()) {
    throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider returned no completed output.');
  }
  const result: LipSyncResult = {
    provider: 'sync-labs',
    providerJobId,
    outputUrl: httpsUrl(job.outputUrl, 'Lip-sync provider output'),
  };
  if (job.outputDuration !== undefined) {
    const duration = Number(job.outputDuration);
    if (!Number.isFinite(duration) || duration < 0) {
      throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider returned an invalid output duration.');
    }
    result.outputDurationSeconds = duration;
  }
  return result;
}

export class SyncLabsLipSyncProvider implements LipSyncProvider {
  readonly id = 'sync-labs';
  readonly available: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPollAttempts: number;
  private readonly requestTimeoutMs: number;

  constructor(options: SyncLabsOptions) {
    this.apiKey = options.apiKey?.trim() ?? '';
    this.available = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxPollAttempts = positiveInteger(options.maxPollAttempts, DEFAULT_MAX_POLL_ATTEMPTS, 'Sync Labs poll attempts');
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'Sync Labs request timeout');
  }

  private async requestJson(url: string, init: RequestInit): Promise<SyncJobResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new LipSyncProviderError('LIP_SYNC_FAILED', 'Lip-sync provider request failed.');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider returned invalid JSON.');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider returned an invalid response.');
      }
      return body as SyncJobResponse;
    } catch (error) {
      if (error instanceof LipSyncProviderError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new LipSyncProviderError('LIP_SYNC_TIMEOUT', 'Lip-sync provider request timed out.');
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LipSyncProviderError('LIP_SYNC_TIMEOUT', 'Lip-sync provider request timed out.');
      }
      throw new LipSyncProviderError('LIP_SYNC_FAILED', 'Lip-sync provider request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  private terminalOrPending(job: SyncJobResponse, expectedJobId?: string): { jobId: string; status: SyncJobStatus; result?: LipSyncResult } {
    const jobId = responseJobId(job.id);
    if (expectedJobId && jobId !== expectedJobId) {
      throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Lip-sync provider changed job identity.');
    }
    const status = responseStatus(job.status);
    if (status === 'FAILED' || status === 'REJECTED') {
      throw new LipSyncProviderError('LIP_SYNC_FAILED', 'Lip-sync provider rejected or failed the render.');
    }
    if (status === 'COMPLETED') {
      return { jobId, status, result: completedResult(job, jobId) };
    }
    return { jobId, status };
  }

  async render(input: LipSyncInput): Promise<LipSyncResult> {
    if (!this.available) {
      throw new LipSyncProviderError('LIP_SYNC_UNAVAILABLE', 'Visual lip-sync provider is unavailable.');
    }

    const videoUrl = httpsUrl(input.videoUrl, 'Lip-sync video input');
    const audioUrl = httpsUrl(input.audioUrl, 'Lip-sync audio input');
    const headers = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
    };

    const created = await this.requestJson(`${SYNC_BASE_URL}/v2/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: SYNC_MODEL,
        input: [
          { type: 'video', url: videoUrl },
          { type: 'audio', url: audioUrl },
        ],
      }),
    });
    const initial = this.terminalOrPending(created);
    if (initial.result) return initial.result;

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const polled = await this.requestJson(
        `${SYNC_BASE_URL}/v2/generate/${encodeURIComponent(initial.jobId)}?wait=true`,
        { method: 'GET', headers: { 'x-api-key': this.apiKey } },
      );
      const state = this.terminalOrPending(polled, initial.jobId);
      if (state.result) return state.result;
    }

    throw new LipSyncProviderError('LIP_SYNC_TIMEOUT', 'Lip-sync provider did not reach a terminal state in time.');
  }
}
