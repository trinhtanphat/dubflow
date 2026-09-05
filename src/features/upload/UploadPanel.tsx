import { useRef, useState } from 'react';
import { CloudUpload, Link2, MonitorUp, Check } from 'lucide-react';
import { readMediaDuration, validateMediaSelection } from './mediaValidation';

type Props = { file: File | null; onFile: (file: File | null) => void };

export function UploadPanel({ file, onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const accept = async (next: File | null) => {
    if (!next) return;
    setChecking(true);
    setError(null);
    try {
      const nextError = await validateMediaSelection(next, readMediaDuration);
      setError(nextError);
      if (!nextError) onFile(next);
    } catch {
      setError('Không thể đọc thời lượng video. Hãy thử một file khác.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="upload-block">
      <div className="rail-heading">Tải lên video</div>
      <div
        className="drop-zone"
        role="button"
        tabIndex={0}
        aria-busy={checking}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void accept(event.dataTransfer.files[0] ?? null); }}
      >
        <CloudUpload size={31} strokeWidth={1.7} />
        <strong>{checking ? 'Đang kiểm tra video...' : 'Kéo & thả file video vào đây'}</strong>
        <span>{checking ? 'Đọc metadata & thời lượng' : 'hoặc bấm để chọn'}</span>
        <div className="upload-actions">
          <button type="button"><MonitorUp size={15}/> Từ máy tính</button>
          <button type="button"><Link2 size={15}/> Từ URL</button>
        </div>
        <input ref={inputRef} hidden type="file" accept="video/mp4,video/webm,video/quicktime,.mkv" onChange={(event) => { void accept(event.currentTarget.files?.[0] ?? null); }} />
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="selected-file">
        <div className="file-thumb"><img src="/demo-frame.svg" alt="" /></div>
        <div className="file-copy">
          <strong>{file?.name ?? 'xianxia_ep01.mp4'}</strong>
          <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : '45:23   ·   1.2 GB'}</span>
        </div>
        <Check size={18} className="success-check" />
      </div>
    </div>
  );
}
