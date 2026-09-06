import { useEffect, useState } from 'react';
import { createShare, listShares, revokeShare, type ExportShare } from './shareApi';

export const DEFAULT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SHARE_TTL_OPTIONS = [
  { seconds: 60 * 60, label: '1 giờ' },
  { seconds: 24 * 60 * 60, label: '24 giờ' },
  { seconds: DEFAULT_SHARE_TTL_SECONDS, label: '7 ngày' },
  { seconds: 30 * 24 * 60 * 60, label: '30 ngày' },
] as const;

export type SharePanelViewProps = {
  shares: ExportShare[];
  createdShareUrl: string;
  loading: boolean;
  busy: boolean;
  error: string;
  expiresInSeconds?: number;
  onExpiresInSecondsChange?(seconds: number): void;
  onCreate(): void;
  onCopy(): void;
  onRevoke(shareId: string): void;
  onClose(): void;
};

type ClipboardWriter = { writeText(text: string): Promise<void> };

export async function copyShareLink(url: string, clipboard?: ClipboardWriter): Promise<void> {
  const normalized = url.trim();
  if (!normalized) throw new Error('Share link is unavailable.');
  const writer = clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
  if (!writer?.writeText) throw new Error('Clipboard is unavailable.');
  await writer.writeText(normalized);
}

const statusCopy: Record<ExportShare['status'], string> = {
  active: 'Đang hoạt động',
  expired: 'Hết hạn',
  revoked: 'Đã thu hồi',
};

function formatExpiry(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('vi-VN');
}

export function SharePanelView({
  shares,
  createdShareUrl,
  loading,
  busy,
  error,
  expiresInSeconds = DEFAULT_SHARE_TTL_SECONDS,
  onExpiresInSecondsChange,
  onCreate,
  onCopy,
  onRevoke,
  onClose,
}: SharePanelViewProps) {
  return (
    <section className="share-panel" aria-label="Chia sẻ video dubbing">
      <div className="share-panel__header">
        <div>
          <strong>Chia sẻ video</strong>
          <span>Liên kết có thể thu hồi và tự hết hạn.</span>
        </div>
        <button type="button" className="share-panel__close" onClick={onClose} aria-label="Đóng chia sẻ">×</button>
      </div>

      {createdShareUrl ? (
        <div className="share-panel__created" role="status">
          <strong>Liên kết mới — hãy sao chép ngay</strong>
          <p>Liên kết bí mật này chỉ hiển thị trong phiên tạo hiện tại.</p>
          <div className="share-panel__link-row">
            <code>{createdShareUrl}</code>
            <button type="button" onClick={onCopy}>Sao chép</button>
          </div>
        </div>
      ) : (
        <p className="share-panel__notice">
          Liên kết bí mật chỉ hiển thị một lần khi tạo. Sau khi tải lại, hãy tạo liên kết mới nếu cần chia sẻ lại.
        </p>
      )}

      {error ? <p className="share-panel__error" role="alert">{error}</p> : null}

      <div className="share-panel__actions">
        <label className="share-panel__ttl">
          <span>Thời hạn liên kết</span>
          <select
            value={expiresInSeconds}
            disabled={busy}
            onChange={(event) => onExpiresInSecondsChange?.(Number(event.target.value))}
          >
            {SHARE_TTL_OPTIONS.map((option) => (
              <option key={option.seconds} value={option.seconds}>{option.label}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={onCreate}>
          {busy ? 'Đang xử lý…' : 'Tạo liên kết mới'}
        </button>
      </div>

      <div className="share-panel__list" aria-live="polite">
        {loading ? <p>Đang tải liên kết chia sẻ…</p> : null}
        {!loading && shares.length === 0 ? <p>Chưa có liên kết chia sẻ.</p> : null}
        {shares.map((share) => (
          <article className={`share-panel__item share-panel__item--${share.status}`} key={share.id}>
            <div>
              <strong>{statusCopy[share.status]}</strong>
              <span>Mã cuối: {share.tokenHint}</span>
              <small>Hết hạn: {formatExpiry(share.expiresAt)}</small>
            </div>
            {share.status === 'active' ? (
              <button type="button" disabled={busy} onClick={() => onRevoke(share.id)}>Thu hồi</button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export type SharePanelProps = {
  projectId: string;
  exportId?: string;
  onClose(): void;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SharePanel({ projectId, exportId, onClose }: SharePanelProps) {
  const [shares, setShares] = useState<ExportShare[]>([]);
  const [createdShareUrl, setCreatedShareUrl] = useState('');
  const [expiresInSeconds, setExpiresInSeconds] = useState(DEFAULT_SHARE_TTL_SECONDS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setCreatedShareUrl('');
    listShares(projectId)
      .then((items) => {
        if (!cancelled) setShares(items);
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason, 'Không thể tải liên kết chia sẻ.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, exportId]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await createShare(projectId, expiresInSeconds, exportId);
      setCreatedShareUrl(result.shareUrl);
      setShares((current) => [result.share, ...current.filter((share) => share.id !== result.share.id)]);
    } catch (reason) {
      setError(message(reason, 'Không thể tạo liên kết chia sẻ.'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await copyShareLink(createdShareUrl);
    } catch (reason) {
      setError(message(reason, 'Không thể sao chép liên kết chia sẻ.'));
    }
  };

  const revoke = async (shareId: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const revoked = await revokeShare(projectId, shareId);
      setShares((current) => current.map((share) => share.id === revoked.id ? revoked : share));
      if (shares.some((share) => share.id === revoked.id) && createdShareUrl) setCreatedShareUrl('');
    } catch (reason) {
      setError(message(reason, 'Không thể thu hồi liên kết chia sẻ.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SharePanelView
      shares={shares}
      createdShareUrl={createdShareUrl}
      loading={loading}
      busy={busy}
      error={error}
      expiresInSeconds={expiresInSeconds}
      onExpiresInSecondsChange={setExpiresInSeconds}
      onCreate={() => { void create(); }}
      onCopy={() => { void copy(); }}
      onRevoke={(shareId) => { void revoke(shareId); }}
      onClose={onClose}
    />
  );
}
