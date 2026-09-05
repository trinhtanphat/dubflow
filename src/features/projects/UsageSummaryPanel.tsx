import type { UsageSummaryResponse, UsageTotals } from './usageApi';

export type UsageSummaryPanelProps = {
  summary: UsageSummaryResponse | null;
  loading: boolean;
  error: string;
};

function formatUsageTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0 giây';
  if (seconds >= 60) {
    return `${(seconds / 60).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} phút`;
  }
  return `${seconds.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} giây`;
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  return Math.round(value).toLocaleString('vi-VN');
}

function hasUsage(totals: UsageTotals): boolean {
  return totals.asrAudioSeconds > 0 || totals.translationCharacters > 0 || totals.ttsAudioSeconds > 0 || totals.renderSeconds > 0;
}

export function UsageSummaryPanel({ summary, loading, error }: UsageSummaryPanelProps) {
  return (
    <section className="usage-summary" aria-label="Mức sử dụng YupVox">
      <div className="usage-summary__heading">
        <div>
          <span className="usage-summary__eyebrow">Usage · Phase 3B</span>
          <h2>Mức sử dụng</h2>
        </div>
        {summary ? (
          <div className="usage-summary__credits" title="Số dư nội bộ chỉ để tham khảo, chưa dùng để tính phí hoặc giới hạn dịch vụ.">
            <span>Credits nội bộ</span>
            <strong>{formatInteger(summary.creditBalance)}</strong>
          </div>
        ) : null}
      </div>

      {loading ? <p className="usage-summary__state" role="status">Đang tải mức sử dụng…</p> : null}
      {error ? <p className="usage-summary__error" role="alert">{error}</p> : null}

      {summary ? (
        <>
          <div className="usage-summary__metrics">
            <div><span>ASR</span><strong>{formatUsageTime(summary.totals.asrAudioSeconds)}</strong></div>
            <div><span>Dịch</span><strong>{formatInteger(summary.totals.translationCharacters)} ký tự</strong></div>
            <div><span>Voice</span><strong>{formatUsageTime(summary.totals.ttsAudioSeconds)}</strong></div>
            <div><span>Render</span><strong>{formatUsageTime(summary.totals.renderSeconds)}</strong></div>
          </div>

          <details className="usage-summary__providers">
            <summary>Theo provider</summary>
            {Object.entries(summary.providers).length === 0 ? (
              <p>Chưa có provider usage hoàn tất.</p>
            ) : (
              <div className="usage-summary__provider-list">
                {Object.entries(summary.providers).map(([provider, totals]) => (
                  <article key={provider}>
                    <strong>{provider}</strong>
                    {hasUsage(totals) ? (
                      <span>
                        ASR {formatUsageTime(totals.asrAudioSeconds)} · Dịch {formatInteger(totals.translationCharacters)} · Voice {formatUsageTime(totals.ttsAudioSeconds)} · Render {formatUsageTime(totals.renderSeconds)}
                      </span>
                    ) : <span>Chưa có usage hoàn tất.</span>}
                  </article>
                ))}
              </div>
            )}
          </details>
        </>
      ) : null}
    </section>
  );
}
