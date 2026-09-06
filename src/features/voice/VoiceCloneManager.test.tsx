import { describe, expect, it } from 'vitest';
import { isVoiceCloneAssignable, voiceCloneStatusLabel } from './VoiceCloneManager';

describe('VoiceCloneManager status semantics', () => {
  it('keeps verification-required clones non-assignable', () => {
    expect(isVoiceCloneAssignable({ status: 'verification_required', providerVoiceId: 'v1' } as any)).toBe(false);
    expect(isVoiceCloneAssignable({ status: 'ready', providerVoiceId: null } as any)).toBe(false);
    expect(isVoiceCloneAssignable({ status: 'ready', providerVoiceId: 'v1' } as any)).toBe(true);
  });

  it('uses truthful visible lifecycle labels', () => {
    expect(voiceCloneStatusLabel('creating')).toMatch(/tạo|xử lý/i);
    expect(voiceCloneStatusLabel('verification_required')).toMatch(/xác minh/i);
    expect(voiceCloneStatusLabel('ready')).toMatch(/sẵn sàng/i);
    expect(voiceCloneStatusLabel('failed')).toMatch(/lỗi/i);
    expect(voiceCloneStatusLabel('deleting')).toMatch(/xóa/i);
  });
});
