import { describe, expect, it, vi } from 'vitest';
import { launchWithLocalVietnameseVoice } from './StudioShell';

describe('Studio local Vietnamese voice export ordering', () => {
  it('prepares Vietnamese cache before launching dubbed_only current export', async () => {
    const events: string[] = [];
    const prepare = vi.fn(async () => { events.push('prepare'); });
    const launch = vi.fn(async () => { events.push('launch'); return 'ok'; });

    await expect(launchWithLocalVietnameseVoice({
      projectId: 'p1',
      targetLanguages: ['vi'],
      output: 'dubbed',
      audioMode: 'dubbed_only',
      localSupported: true,
    }, launch, prepare)).resolves.toBe('ok');
    expect(events).toEqual(['prepare', 'launch']);
  });

  it('prepares once before a batch launch when Vietnamese is among selected targets', async () => {
    const events: string[] = [];
    const prepare = vi.fn(async () => { events.push('prepare'); });
    const launch = vi.fn(async () => { events.push('batch'); return 2; });

    await expect(launchWithLocalVietnameseVoice({
      projectId: 'p1',
      targetLanguages: ['ja', 'vi'],
      output: 'dubbed',
      audioMode: 'dubbed_only',
      localSupported: true,
    }, launch, prepare)).resolves.toBe(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['prepare', 'batch']);
  });

  it('never loads local Piper for subtitles, non-Vietnamese targets, or hybrid audio modes', async () => {
    const cases = [
      { targetLanguages: ['vi'] as const, output: 'subtitles' as const, audioMode: 'dubbed_only' as const, localSupported: true },
      { targetLanguages: ['ja'] as const, output: 'dubbed' as const, audioMode: 'dubbed_only' as const, localSupported: true },
      { targetLanguages: ['vi'] as const, output: 'dubbed' as const, audioMode: 'duck_original' as const, localSupported: true },
      { targetLanguages: ['vi'] as const, output: 'dubbed' as const, audioMode: 'separated_background' as const, localSupported: true },
    ];

    for (const item of cases) {
      const prepare = vi.fn(async () => {});
      const launch = vi.fn(async () => 'launched');
      await expect(launchWithLocalVietnameseVoice({
        projectId: 'p1',
        targetLanguages: [...item.targetLanguages],
        output: item.output,
        audioMode: item.audioMode,
        localSupported: item.localSupported,
      }, launch, prepare)).resolves.toBe('launched');
      expect(prepare).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledTimes(1);
    }
  });

  it('fails Vietnamese dubbed_only closed before launch when local Piper is unsupported', async () => {
    const prepare = vi.fn(async () => {});
    const launch = vi.fn(async () => 'must-not-run');

    await expect(launchWithLocalVietnameseVoice({
      projectId: 'p1',
      targetLanguages: ['vi'],
      output: 'dubbed',
      audioMode: 'dubbed_only',
      localSupported: false,
    }, launch, prepare)).rejects.toThrow(/Piper|local/i);
    expect(prepare).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not launch export when local cache preparation fails', async () => {
    const conflict = Object.assign(new Error('Translation changed.'), { status: 409, code: 'TRANSLATION_VARIANT_CONFLICT' });
    const prepare = vi.fn(async () => { throw conflict; });
    const launch = vi.fn(async () => 'must-not-run');

    await expect(launchWithLocalVietnameseVoice({
      projectId: 'p1',
      targetLanguages: ['vi'],
      output: 'dubbed',
      audioMode: 'dubbed_only',
      localSupported: true,
    }, launch, prepare)).rejects.toMatchObject({ status: 409, code: 'TRANSLATION_VARIANT_CONFLICT' });
    expect(launch).not.toHaveBeenCalled();
  });
});
