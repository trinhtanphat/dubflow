import { IconButton } from '../components/IconButton/IconButton';
import { StatusBadge } from '../components/StatusBadge/StatusBadge';
import { Tooltip } from '../components/Tooltip/Tooltip';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'retrying' | 'error' | 'conflict';
export type CloudState = 'ready' | 'processing' | 'degraded';

type StudioTopbarProps = {
  projectTitle: string;
  saveState: SaveState;
  cloudState: CloudState;
  cloudProgress?: number;
  cloudDetail?: string;
  canUndo: boolean;
  canRedo: boolean;
  canExport?: boolean;
  exportBusy?: boolean;
  exportHref?: string;
  canShare?: boolean;
  onUndo(): void;
  onRedo(): void;
  onOpenCommands(): void;
  onOpenSources?(): void;
  onOpenInspector?(): void;
  onExport?(): void;
  onShare?(): void;
};

const saveCopy = {
  saved: { label: 'Đã lưu', detail: 'Đã đồng bộ Cloud', tone: 'success' },
  dirty: { label: 'Chưa lưu', detail: 'Đang chờ tự động lưu', tone: 'warning' },
  saving: { label: 'Đang lưu…', detail: 'Đang đồng bộ thay đổi', tone: 'accent' },
  offline: { label: 'Offline', detail: 'Thay đổi chỉ ở local', tone: 'warning' },
  retrying: { label: 'Đang thử lại', detail: 'Đang kết nối lại', tone: 'warning' },
  error: { label: 'Lỗi lưu', detail: 'Cần thử lưu lại', tone: 'danger' },
  conflict: { label: 'Xung đột', detail: 'Cần chọn cách xử lý', tone: 'danger' },
} as const;

const cloudCopy = {
  ready: { label: 'Cloud ready', detail: 'Workers online', tone: 'success' },
  processing: { label: 'Processing', detail: 'Cloud job active', tone: 'accent' },
  degraded: { label: 'Cloud degraded', detail: 'Some providers unavailable', tone: 'warning' },
} as const;

export function StudioTopbar({
  projectTitle,
  saveState,
  cloudState,
  cloudProgress,
  cloudDetail,
  canUndo,
  canRedo,
  canExport = false,
  exportBusy = false,
  exportHref,
  canShare = false,
  onUndo,
  onRedo,
  onOpenCommands,
  onOpenSources,
  onOpenInspector,
  onExport,
  onShare,
}: StudioTopbarProps) {
  const save = saveCopy[saveState];
  const cloud = cloudCopy[cloudState];
  const progress = typeof cloudProgress === 'number' && Number.isFinite(cloudProgress)
    ? Math.round(Math.max(0, Math.min(1, cloudProgress)) * 100)
    : null;
  const cloudStatusDetail = cloudState === 'processing'
    ? `${cloudDetail?.trim() || cloud.detail}${progress === null ? '' : ` · ${progress}%`}`
    : cloudDetail?.trim() || cloud.detail;

  return (
    <header className="topbar studio-topbar">
      <div className="brand">
        <div className="brand-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
        <div className="brand-copy"><strong>YupVox.Com</strong><span>AI Studio Dubbing</span></div>
      </div>

      <div className="project-title studio-project-title reference-project-name">
        <span>Dự án:</span>
        <strong>{projectTitle}</strong>
        <IconButton label="Đổi tên dự án" icon="✎" />
      </div>

      <div className="topbar-actions studio-topbar-actions">
        <div className="mobile-panel-actions" aria-label="Bảng công cụ mobile">
          <IconButton label="Mở nguồn media" icon="☰" onClick={onOpenSources} />
          <IconButton label="Mở inspector" icon="☷" onClick={onOpenInspector} />
        </div>
        <div className="studio-statuses reference-cloud-status">
          <StatusBadge label={save.label} detail={save.detail} tone={save.tone} />
          <StatusBadge label={cloud.label} detail={cloudStatusDetail} tone={cloud.tone} />
        </div>
        <div className="studio-history-actions reference-secondary-actions" aria-label="Lịch sử chỉnh sửa">
          <Tooltip text={canUndo ? 'Hoàn tác' : 'Chưa có thay đổi để hoàn tác'}>
            <IconButton label="Hoàn tác" icon="↶" disabled={!canUndo} onClick={onUndo} />
          </Tooltip>
          <Tooltip text={canRedo ? 'Làm lại' : 'Chưa có thay đổi để làm lại'}>
            <IconButton label="Làm lại" icon="↷" disabled={!canRedo} onClick={onRedo} />
          </Tooltip>
          <Tooltip text="Bảng lệnh · Ctrl/⌘ K">
            <IconButton label="Mở bảng lệnh" icon="⌘" onClick={onOpenCommands} />
          </Tooltip>
        </div>
        <div className="credits studio-credits"><span>✦</span><div><strong>50,000</strong><small>Credits</small></div></div>
        <div className="avatar" aria-label="Tài khoản YupVox">YV</div>
        {exportHref ? (
          <>
            <a className="export-button reference-export-button" href={exportHref}>Tải Dubbing</a>
            {canShare ? (
              <button className="export-button share-button" type="button" onClick={onShare}>Chia sẻ</button>
            ) : null}
          </>
        ) : (
          <Tooltip text={canExport ? 'Tạo video dubbing cuối cùng' : 'Hoàn tất xử lý và review trước khi xuất bản'}>
            <button
              className="export-button reference-export-button"
              type="button"
              disabled={!canExport || exportBusy}
              onClick={onExport}
            >
              {exportBusy ? 'Đang xuất…' : 'Xuất bản Dubbing'}
            </button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
