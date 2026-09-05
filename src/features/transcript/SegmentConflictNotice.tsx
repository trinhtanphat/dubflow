import type { SegmentField } from '../../app/autosaveDraft';
import type { Segment } from '../timeline/types';

type SegmentConflictNoticeProps = {
  local: Segment;
  server: Segment;
  touchedFields: SegmentField[];
  onUseServer(): void;
  onReapply(): void;
};

const fieldLabels: Record<SegmentField, string> = {
  sourceText: 'Lời thoại gốc',
  translatedText: 'Bản dịch',
  speakerId: 'Nhân vật',
};

function fieldValue(segment: Segment, field: SegmentField): string {
  if (field === 'sourceText') return segment.sourceText;
  if (field === 'translatedText') return segment.translatedText;
  return segment.speakerId;
}

export function SegmentConflictNotice({
  local,
  server,
  touchedFields,
  onUseServer,
  onReapply,
}: SegmentConflictNoticeProps) {
  return (
    <section className="segment-conflict-notice" role="alert" aria-label="Xung đột lưu segment">
      <strong>Xung đột</strong>
      <p>Segment đã thay đổi trên server. Bản nháp của bạn vẫn được giữ nguyên.</p>
      <div className="segment-conflict-values">
        {touchedFields.map((field) => (
          <div key={field}>
            <span>{fieldLabels[field]}</span>
            <p><b>Của tôi:</b> {fieldValue(local, field)}</p>
            <p><b>Server:</b> {fieldValue(server, field)}</p>
          </div>
        ))}
      </div>
      <div className="segment-conflict-actions">
        <button type="button" className="ghost-button" onClick={onUseServer}>Dùng bản mới trên server</button>
        <button type="button" className="secondary-button" onClick={onReapply}>Áp dụng lại thay đổi của tôi</button>
      </div>
    </section>
  );
}
