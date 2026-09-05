import { IconButton } from '../components/IconButton/IconButton';
import { StatusBadge } from '../components/StatusBadge/StatusBadge';
import { Tooltip } from '../components/Tooltip/Tooltip';

export type SaveState = 'saved' | 'saving' | 'offline' | 'retrying' | 'error';
export type CloudState = 'ready' | 'processing' | 'degraded';

type StudioTopbarProps = {
  projectTitle: string;
  saveState: SaveState;
  cloudState: CloudState;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onOpenCommands(): void;
};

const saveCopy = {
  saved: { label: 'Saved', detail: 'Cloud synced', tone: 'success' },
  saving: { label: 'Saving…', detail: 'Syncing changes', tone: 'accent' },
  offline: { label: 'Offline', detail: 'Changes stay local', tone: 'warning' },
  retrying: { label: 'Retrying', detail: 'Reconnecting', tone: 'warning' },
  error: { label: 'Save failed', detail: 'Retry required', tone: 'danger' },
} as const;

const cloudCopy = {
  ready: { label: 'Cloud ready', detail: 'Workers online', tone: 'success' },
  processing: { label: 'Processing', detail: 'Cloud job active', tone: 'accent' },
  degraded: { label: 'Cloud degraded', detail: 'Some providers unavailable', tone: 'warning' },
} as const;

export function StudioTopbar({ projectTitle, saveState, cloudState, canUndo, canRedo, onUndo, onRedo, onOpenCommands }: StudioTopbarProps) {
  const save = saveCopy[saveState];
  const cloud = cloudCopy[cloudState];

  return (
    <header className="topbar studio-topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">Y</div>
        <div className="brand-copy"><strong>YupVox</strong><span>Studio Pro</span></div>
      </div>

      <div className="project-title studio-project-title">
        <span>Dự án</span>
        <strong>{projectTitle}</strong>
        <IconButton label="Đổi tên dự án" icon="✎" />
      </div>

      <div className="topbar-actions studio-topbar-actions">
        <div className="studio-statuses">
          <StatusBadge label={save.label} detail={save.detail} tone={save.tone} />
          <StatusBadge label={cloud.label} detail={cloud.detail} tone={cloud.tone} />
        </div>
        <div className="studio-history-actions" aria-label="Lịch sử chỉnh sửa">
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
        <Tooltip text="Export sẽ bật khi media processor được cấu hình và capability pass">
          <button className="export-button" type="button" disabled>Xuất bản</button>
        </Tooltip>
      </div>
    </header>
  );
}
