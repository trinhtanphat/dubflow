import { useEffect, useState } from 'react';
import { Panel } from '../../components/ui/Panel';
import { fetchVoiceCapabilities, type VoiceCapabilities } from './voiceApi';
import {
  assignManagedVoiceClone,
  createVoiceClone,
  deleteManagedVoiceClone,
  enrollManagedVoiceClone,
  listVoiceClones,
  uploadVoiceCloneSample,
  type VoiceClone,
  type VoiceCloneStatus,
} from './voiceCloneApi';

export function isVoiceCloneAssignable(clone: Pick<VoiceClone, 'status' | 'providerVoiceId'>): boolean {
  return clone.status === 'ready' && Boolean(clone.providerVoiceId);
}

export function voiceCloneStatusLabel(status: VoiceCloneStatus): string {
  switch (status) {
    case 'creating': return 'Đang tạo / chờ xử lý';
    case 'verification_required': return 'Cần xác minh với nhà cung cấp';
    case 'ready': return 'Sẵn sàng';
    case 'failed': return 'Lỗi';
    case 'deleting': return 'Đang xóa';
    case 'deleted': return 'Đã xóa';
  }
}

type VoiceCloneManagerProps = {
  projectId: string;
  speakerId?: string;
};

type EnrollmentStage = 'idle' | 'uploading' | 'enrolling';

export function VoiceCloneManager({ projectId, speakerId }: VoiceCloneManagerProps) {
  const [capabilities, setCapabilities] = useState<VoiceCapabilities | null>(null);
  const [clones, setClones] = useState<VoiceClone[]>([]);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [sample, setSample] = useState<File | null>(null);
  const [stage, setStage] = useState<EnrollmentStage>('idle');
  const [message, setMessage] = useState('');

  const refresh = async () => {
    const [nextCapabilities, nextClones] = await Promise.all([
      fetchVoiceCapabilities(),
      listVoiceClones(projectId),
    ]);
    setCapabilities(nextCapabilities);
    setClones(nextClones);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchVoiceCapabilities(), listVoiceClones(projectId)])
      .then(([nextCapabilities, nextClones]) => {
        if (cancelled) return;
        setCapabilities(nextCapabilities);
        setClones(nextClones);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Không thể tải Voice Clone.');
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const enroll = async () => {
    if (!capabilities?.cloneEnrollment.available || !consent || !sample || !name.trim() || stage !== 'idle') return;
    setMessage('');
    setStage('uploading');
    try {
      const clone = await createVoiceClone(projectId, name.trim());
      await uploadVoiceCloneSample(projectId, clone.id, sample);
      setStage('enrolling');
      const enrolled = await enrollManagedVoiceClone(projectId, clone.id);
      setMessage(enrolled.status === 'verification_required'
        ? 'Voice đã được tạo nhưng cần xác minh với ElevenLabs trước khi có thể gán.'
        : 'Voice Clone đã sẵn sàng. Bạn có thể gán thủ công cho nhân vật.');
      setName('');
      setConsent(false);
      setSample(null);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể tạo Voice Clone.');
      await refresh().catch(() => undefined);
    } finally {
      setStage('idle');
    }
  };

  const assign = async (clone: VoiceClone) => {
    if (!speakerId || !isVoiceCloneAssignable(clone)) return;
    setMessage('');
    try {
      await assignManagedVoiceClone(projectId, speakerId, clone.id);
      setMessage('Đã gán Voice Clone cho nhân vật. Audio cũ và export cũ đã được vô hiệu hóa để render lại.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể gán Voice Clone.');
    }
  };

  const remove = async (clone: VoiceClone) => {
    if (clone.status === 'deleted' || clone.status === 'deleting') return;
    setMessage('');
    try {
      await deleteManagedVoiceClone(projectId, clone.id);
      await refresh();
      setMessage('Đã xóa Voice Clone khỏi nhà cung cấp và YupVox.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể xóa Voice Clone.');
      await refresh().catch(() => undefined);
    }
  };

  const available = capabilities?.cloneEnrollment.available === true;
  const busy = stage !== 'idle';

  return (
    <Panel title="Voice Clone an toàn">
      <div className="voice-clone-manager">
        {!capabilities ? (
          <small>Đang kiểm tra capability…</small>
        ) : !available ? (
          <small>Voice Clone chưa khả dụng vì ElevenLabs chưa được cấu hình.</small>
        ) : (
          <div className="speaker-voice-editor voice-clone-enroll">
            <input
              aria-label="Tên Voice Clone"
              value={name}
              maxLength={80}
              placeholder="Tên voice"
              onChange={(event) => setName(event.target.value)}
            />
            <input
              aria-label="Mẫu giọng Voice Clone"
              type="file"
              accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/webm,audio/ogg"
              onChange={(event) => setSample(event.target.files?.[0] ?? null)}
            />
            <label className="voice-clone-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              Tôi xác nhận có quyền và sự đồng ý cần thiết để tạo và sử dụng bản sao giọng này.
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !consent || !sample || !name.trim()}
              onClick={() => { void enroll(); }}
            >
              {stage === 'uploading' ? 'Đang tải mẫu…' : stage === 'enrolling' ? 'Đang tạo Voice Clone…' : 'Tạo Voice Clone'}
            </button>
          </div>
        )}

        <div className="voice-clone-list">
          {clones.filter((clone) => clone.status !== 'deleted').map((clone) => (
            <article key={clone.id} className="voice-clone-row">
              <div>
                <strong>{clone.name}</strong>
                <small>{voiceCloneStatusLabel(clone.status)}</small>
                {clone.status === 'verification_required' && (
                  <small>Không thể gán cho tới khi provider verification được hoàn tất.</small>
                )}
                {clone.errorCode && <small>{clone.errorCode}</small>}
              </div>
              <div className="voice-clone-actions">
                {speakerId && isVoiceCloneAssignable(clone) && (
                  <button type="button" className="secondary-button" onClick={() => { void assign(clone); }}>
                    Gán cho nhân vật
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={clone.status === 'deleting'}
                  onClick={() => { void remove(clone); }}
                >Xóa</button>
              </div>
            </article>
          ))}
        </div>
        {message && <small role="status">{message}</small>}
      </div>
    </Panel>
  );
}
