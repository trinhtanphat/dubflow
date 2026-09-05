import { useState, type ReactNode } from 'react';
import { Panel } from '../../components/ui/Panel';
import { validateMediaFile } from './mediaValidation';
import type { CloudProject } from '../projects/projectApi';
import { runCloudUploadFlow, type CloudUploadFlowResult } from './cloudUploadFlow';
import './upload.css';

export type UploadPanelProps = {
  onProcessStarted?: (result: CloudUploadFlowResult) => void;
  speakerSection?: ReactNode;
};

export function UploadPanel({ onProcessStarted, speakerSection }: UploadPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState<CloudProject['sourceLanguage']>('zh');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Chưa tải video lên cloud.');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);

  const chooseFile = (next?: File) => {
    setError('');
    setProgress(0);
    if (!next) { setFile(null); return; }
    const validation = validateMediaFile(next);
    if (!validation.valid) { setFile(null); setError(validation.error); return; }
    setFile(next);
    setStatus(`${next.name} · ${(next.size / (1024 * 1024)).toFixed(1)} MB · sẵn sàng upload`);
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true); setError(''); setProgress(0);
    try {
      setStatus('Đang tạo project D1 và upload multipart vào R2…');
      const result = await runCloudUploadFlow(file, sourceLanguage, undefined, setProgress);
      setStatus(`Đã upload R2 · Workflow ${result.job.workflowId} đang xử lý AI.`);
      onProcessStarted?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload hoặc khởi động AI thất bại.');
      setStatus('Cloud pipeline chưa khởi động hoàn tất.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="Tải lên video">
        <label className="upload-dropzone reference-drop-zone">
          <span className="upload-dropzone__icon" aria-hidden="true">☁</span>
          <strong>{file ? file.name : 'Kéo & thả file video vào đây'}</strong>
          <span>{file ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : 'hoặc bấm để chọn'}</span>
          <input type="file" accept="video/mp4,video/webm,video/x-matroska,video/quicktime,.mkv,.mov" onChange={(event: any) => chooseFile(event.target.files?.[0])} />
        </label>
        <div className="media-limit">MP4 · WebM · MKV · MOV · tối đa 5 GB / 3 giờ</div>
        {progress > 0 && <div className="upload-progress" aria-label="Tiến trình upload"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        <div className="reference-upload-status"><p className="phase-note">{status}</p></div>
        {error && <p className="error-banner" role="alert">{error}</p>}
      </Panel>

      {speakerSection}

      <Panel title="Ngôn ngữ">
        <label className="field-label" htmlFor="source-language">Ngôn ngữ gốc</label>
        <select id="source-language" value={sourceLanguage} onChange={(event: any) => setSourceLanguage(event.target.value)}>
          <option value="auto">Tự động nhận diện</option>
          <option value="zh">🇨🇳 Tiếng Trung</option>
          <option value="en">🇬🇧 Tiếng Anh</option>
          <option value="ja">🇯🇵 Tiếng Nhật</option>
          <option value="ko">🇰🇷 Tiếng Hàn</option>
        </select>
        <label className="field-label" htmlFor="target-language">Ngôn ngữ dịch</label>
        <select id="target-language" defaultValue="vi" disabled>
          <option value="vi">🇻🇳 Tiếng Việt</option>
        </select>
        <button type="button" className="primary-button reference-dub-button" disabled={!file || busy} onClick={upload}>
          {busy ? `Đang tải ${Math.round(progress * 100)}%` : 'Bắt đầu Dubbing AI'}
        </button>
        <p className="phase-note">AI dịch và xử lý bằng Cloudflare Workflow; transcript tự tải vào editor khi hoàn tất.</p>
      </Panel>
    </>
  );
}
