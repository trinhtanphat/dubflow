import type { Env } from '../env';

export type TelemetryEventName =
  | 'request_completed'
  | 'provider_success'
  | 'provider_failure'
  | 'rate_limited'
  | 'share_access'
  | 'export_download';

export type TelemetryEvent = {
  name: TelemetryEventName;
  requestId?: string;
  actorId?: string;
  projectId?: string;
  jobId?: string;
  shareId?: string;
  operation?: string;
  provider?: string;
  status?: string;
  errorCode?: string;
  method?: string;
  route?: string;
  accessMode?: 'owner' | 'share';
  rangeRequest?: boolean;
  httpStatus?: number;
  durationMs?: number;
};

export interface TelemetrySink {
  write(event: TelemetryEvent): void;
}

export function createTelemetry(env: Pick<Env, 'ANALYTICS'>): TelemetrySink {
  return {
    write(event) {
      env.ANALYTICS.writeDataPoint({
        blobs: [
          event.name,
          event.requestId ?? '',
          event.actorId ?? '',
          event.projectId ?? '',
          event.jobId ?? '',
          event.shareId ?? '',
          event.operation ?? '',
          event.provider ?? '',
          event.status ?? '',
          event.errorCode ?? '',
          event.method ?? '',
          event.route ?? '',
          event.accessMode ?? '',
        ],
        doubles: [
          event.httpStatus ?? 0,
          event.durationMs ?? 0,
          event.rangeRequest ? 1 : 0,
        ],
        indexes: [event.actorId ?? event.projectId ?? event.shareId ?? 'anonymous'],
      });
    },
  };
}

export function emitTelemetry(sink: TelemetrySink, event: TelemetryEvent): void {
  try {
    sink.write(event);
  } catch {
    console.error('telemetry_write_failed');
  }
}

export async function withProviderTelemetry<T>(
  sink: TelemetrySink,
  context: Omit<TelemetryEvent, 'name' | 'status' | 'durationMs'> & { errorCode: string },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const { errorCode: _errorCode, ...successContext } = context;
    emitTelemetry(sink, {
      ...successContext,
      name: 'provider_success',
      status: 'success',
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    emitTelemetry(sink, {
      ...context,
      name: 'provider_failure',
      status: 'failure',
      durationMs: Date.now() - started,
    });
    throw error;
  }
}
