import type { R2PutOptionsLike, R2UploadValue } from '../cloudflare/r2';
import type { ProjectExportRepository } from '../db/project-exports';
import type { ProviderMediaGrantRepository } from '../db/provider-media-grants';
import type { UsageStore } from '../db/usage';
import type { TargetLanguage } from '../domain/language';
import type { TelemetrySink } from '../observability/telemetry';
import { withProviderTelemetry } from '../observability/telemetry';
import { createProviderMediaToken } from '../security/provider-media-token';
import { LipSyncProviderError, type LipSyncProvider } from '../services/lipsync/types';
import { isJobCancelledError } from './jobCancellation';

const GRANT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PROVIDER_MEDIA_ORIGIN = 'https://yupvox.qs3d.site';

export interface VisualLipSyncStepLike {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export type VisualLipSyncDeps = {
  exports: Pick<ProjectExportRepository, 'get' | 'setLipSyncState'>;
  providerMediaGrants: Pick<ProviderMediaGrantRepository, 'create' | 'expire'>;
  lipSync: LipSyncProvider;
  bucket: {
    put?(key: string, value: R2UploadValue, options?: R2PutOptionsLike): Promise<unknown>;
  };
  usage: Pick<UsageStore, 'record' | 'getByOperation'>;
  telemetry: TelemetrySink;
  makeProviderMediaToken?: typeof createProviderMediaToken;
  providerMediaOrigin?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type VisualLipSyncContext = {
  projectId: string;
  userId: string;
  jobId: string;
  retryCount: number;
  requestId?: string;
  targetLanguage: TargetLanguage;
  exportId: string;
  standardObjectKey: string;
  soundtrackObjectKey: string;
  durationMs: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Visual lip-sync failed.';
}

function canonicalLipSyncKey(context: VisualLipSyncContext): string {
  return `projects/${context.projectId}/exports/${context.targetLanguage}/${context.exportId}.lipsync.mp4`;
}

function expectedSoundtrackKey(context: VisualLipSyncContext): string {
  return `projects/${context.projectId}/soundtracks/${context.targetLanguage}/${context.exportId}.wav`;
}

function operationKey(context: VisualLipSyncContext, provider: string): string {
  return `job:${context.jobId}:retry:${context.retryCount}:lipsync:${context.targetLanguage}:${context.exportId}:${provider}`;
}

function providerMediaUrl(origin: string, grantId: string, token: string): string {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    throw new LipSyncProviderError('LIP_SYNC_INPUT_INVALID', 'Provider media origin is invalid.');
  }
  if (base.protocol !== 'https:' || !base.hostname) {
    throw new LipSyncProviderError('LIP_SYNC_INPUT_INVALID', 'Provider media origin must be HTTPS.');
  }
  const url = new URL(`/api/provider-media/${encodeURIComponent(grantId)}`, base);
  url.searchParams.set('token', token);
  return url.toString();
}

function normalizeLipSyncError(error: unknown): LipSyncProviderError {
  if (error instanceof LipSyncProviderError) return error;
  return new LipSyncProviderError('LIP_SYNC_FAILED', errorMessage(error));
}

export async function runVisualLipSync(
  context: VisualLipSyncContext,
  deps: VisualLipSyncDeps,
  step: VisualLipSyncStepLike,
  ensureActive: () => Promise<void>,
): Promise<string> {
  const provider = deps.lipSync.id.trim();
  const canonicalKey = canonicalLipSyncKey(context);
  const grantIds: string[] = [];

  if (!provider || deps.lipSync.available !== true || !deps.bucket.put) {
    throw new LipSyncProviderError('LIP_SYNC_UNAVAILABLE', 'Visual lip-sync provider is unavailable.');
  }
  if (!Number.isFinite(context.durationMs) || context.durationMs <= 0) {
    throw new LipSyncProviderError('LIP_SYNC_INPUT_INVALID', 'Project duration is invalid for visual lip-sync.');
  }
  const audioObjectKey = expectedSoundtrackKey(context);
  if (context.soundtrackObjectKey !== audioObjectKey) {
    throw new LipSyncProviderError('LIP_SYNC_INPUT_INVALID', 'Dubbed soundtrack has an invalid object key.');
  }

  const existing = await step.do('load durable visual lip-sync state', () =>
    deps.exports.get(context.projectId, context.exportId, context.userId),
  );
  if (
    existing?.lipSyncStatus === 'completed'
    && existing.lipSyncProvider === provider
    && existing.lipSyncObjectKey === canonicalKey
    && existing.exportObjectKey === context.standardObjectKey
  ) {
    return canonicalKey;
  }

  const usageKey = operationKey(context, provider);
  const completedUsage = await step.do('load completed visual lip-sync usage', () =>
    deps.usage.getByOperation(usageKey, 'completed'),
  );
  if (completedUsage) {
    throw new LipSyncProviderError(
      'LIP_SYNC_RESPONSE_INVALID',
      'Completed visual lip-sync accounting has no durable canonical artifact.',
    );
  }

  const startedUsage = await step.do('load started visual lip-sync usage', () =>
    deps.usage.getByOperation(usageKey, 'started'),
  );
  const units = context.durationMs / 1000;
  const makeToken = deps.makeProviderMediaToken ?? createProviderMediaToken;
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const origin = deps.providerMediaOrigin ?? DEFAULT_PROVIDER_MEDIA_ORIGIN;

  try {
    await step.do('check cancellation before visual lip-sync preparation', ensureActive);

    await step.do('persist visual lip-sync processing state', () => deps.exports.setLipSyncState(
      context.projectId,
      context.exportId,
      context.userId,
      { requested: true, provider, status: 'processing', objectKey: null },
    ));

    if (!startedUsage) {
      await step.do('record visual lip-sync started usage', () => deps.usage.record({
        userId: context.userId,
        projectId: context.projectId,
        jobId: context.jobId,
        kind: 'lip_sync_video_second',
        units,
        provider,
        phase: 'started',
        operationKey: usageKey,
      }));
    }

    await step.do('check cancellation before visual lip-sync provider', ensureActive);
    const submission = await step.do('render visual lip-sync', async () => {
      const localGrantIds: string[] = [];
      try {
        const expiresAt = new Date(now().getTime() + GRANT_TTL_MS).toISOString();
        const videoToken = await makeToken();
        const videoGrant = await deps.providerMediaGrants.create({
          projectId: context.projectId,
          userId: context.userId,
          objectKey: context.standardObjectKey,
          tokenHash: videoToken.tokenHash,
          expiresAt,
        });
        localGrantIds.push(videoGrant.id);

        const audioToken = await makeToken();
        const audioGrant = await deps.providerMediaGrants.create({
          projectId: context.projectId,
          userId: context.userId,
          objectKey: audioObjectKey,
          tokenHash: audioToken.tokenHash,
          expiresAt,
        });
        localGrantIds.push(audioGrant.id);

        const result = await withProviderTelemetry(deps.telemetry, {
          requestId: context.requestId,
          actorId: context.userId,
          projectId: context.projectId,
          jobId: context.jobId,
          operation: 'lip_sync',
          provider,
          errorCode: 'LIP_SYNC_FAILED',
        }, () => deps.lipSync.render({
          videoUrl: providerMediaUrl(origin, videoGrant.id, videoToken.token),
          audioUrl: providerMediaUrl(origin, audioGrant.id, audioToken.token),
        }));
        return { result, grantIds: localGrantIds };
      } catch (error) {
        for (const grantId of localGrantIds) {
          try {
            await deps.providerMediaGrants.expire(grantId, now());
          } catch {
            // Best-effort cleanup must not replace the provider failure.
          }
        }
        throw error;
      }
    });
    grantIds.push(...submission.grantIds);
    const result = submission.result;
    if (result.provider !== provider || !result.providerJobId.trim()) {
      throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Visual lip-sync provider returned invalid job metadata.');
    }

    await step.do('check cancellation before visual lip-sync publish', ensureActive);
    await step.do('download and publish canonical visual lip-sync output', async () => {
      const providerOutput = await fetchImpl(result.outputUrl, { redirect: 'follow' });
      const contentType = providerOutput.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!providerOutput.ok || !providerOutput.body || !contentType.startsWith('video/')) {
        throw new LipSyncProviderError('LIP_SYNC_RESPONSE_INVALID', 'Visual lip-sync provider returned an invalid media output.');
      }
      await deps.bucket.put!(canonicalKey, providerOutput.body, {
        httpMetadata: { contentType: 'video/mp4' },
      });
      return canonicalKey;
    });

    await step.do('persist completed visual lip-sync state', () => deps.exports.setLipSyncState(
      context.projectId,
      context.exportId,
      context.userId,
      { requested: true, provider, status: 'completed', objectKey: canonicalKey },
    ));

    await step.do('record visual lip-sync completed usage', () => deps.usage.record({
      userId: context.userId,
      projectId: context.projectId,
      jobId: context.jobId,
      kind: 'lip_sync_video_second',
      units,
      provider,
      phase: 'completed',
      operationKey: usageKey,
    }));

    return canonicalKey;
  } catch (error) {
    if (isJobCancelledError(error)) throw error;
    const normalized = normalizeLipSyncError(error);
    try {
      await deps.exports.setLipSyncState(
        context.projectId,
        context.exportId,
        context.userId,
        { requested: true, provider, status: 'failed', objectKey: null },
      );
    } catch {
      // Preserve the primary visual failure if durable state recording also fails.
    }
    throw normalized;
  } finally {
    for (const grantId of grantIds) {
      try {
        await deps.providerMediaGrants.expire(grantId, now());
      } catch {
        // Grant cleanup is best effort and must never replace the primary result.
      }
    }
  }
}
