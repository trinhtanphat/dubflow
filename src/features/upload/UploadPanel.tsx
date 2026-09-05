import { useState } from 'react';
import { Panel } from '../../components/ui/Panel';
import { validateMediaFile } from './mediaValidation';
import { createProject, type CloudProject } from '../projects/projectApi';
import { uploadMediaMultipart } from './multipartApi';
import './upload.css';

export function UploadPanel() {
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
      setStatus('Đang tạo project trên D1…');
      const project = await createProject(file.name.replace(/\.[^.]+$/, '') || 'YupVox project', sourceLanguage);
      setStatus('Đang upload multipart trực tiếp vào R2…');
      const completed = await uploadMediaMultipart(project.id, file, fetch, setProgress);
      setStatus(`Đã upload R2: ${completed.objectKey}. Media processor/ASR sẽ chạy khi container được cấu hình.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload thất bại.');
      setStatus('Upload chưa hoàn tất.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="Tải lên video">
        <label className="upload-dropzone">
          <span className="upload-dropzone__icon" aria-hidden="true">☁</span>
          <strong>{file ? file.name : 'Kéo & thả file video vào đây'}</strong>
          <span>{file ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : 'hoặc bấm để chọn'}</span>
          <input type="file" accept="video/mp4,video/webm,video/x-matroska,video/quicktime,.mkv,.mov" onChange={(event: any) => chooseFile(event.target.files?.[0])} />
        </label>
        <div className="media-limit">MP4 · WebM · MKV · MOV · tối đa 5 GB / 3 giờ</div>
        {progress > 0 && <div className="upload-progress" aria-label="Tiến trình upload"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        <p className="phase-note">{status}</p>
        {error && <p className="error-banner" role="alert">{error}</p>}
      </Panel>

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
        <button type="button" className="primary-button" disabled={!file || busy} onClick={upload}>
          {busy ? `Đang tải ${Math.round(progress * 100)}%` : 'Tạo project & tải lên Cloudflare R2'}
        </button>
        <p className="phase-note">Workers AI + Google Translate đã có provider source; FFmpeg/TTS chỉ bật khi live capability pass.</p>
      </Panel>
    </>
  );
}
