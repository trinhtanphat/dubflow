import { describe, expect, it, vi } from 'vitest';
import { launchWithVietnameseClientVoice } from './clientVoiceExport';


describe('launchWithVietnameseClientVoice', () => {
  it('prepares Vietnamese client voice before dubbed export launch', async () => {
    const events: string[] = [];
    const prepareVietnamese = vi.fn(async () => { events.push('prepare'); });
    const launch = vi.fn(async () => { events.push('launch'); return 'queued'; });

    await expect(launchWithVietnameseClientVoice('dubbed', ['vi'], { prepareVietnamese, launch })).resolves.toBe('queued');
    expect(events).toEqual(['prepare', 'launch']);
  });

  it('never launches export when Vietnamese preload fails', async () => {
    const prepareVietnamese = vi.fn(async () => { throw new Error('Piper preload failed'); });
    const launch = vi.fn(async () => 'queued');

    await expect(launchWithVietnameseClientVoice('dubbed', ['vi'], { prepareVietnamese, launch })).rejects.toThrow(/Piper preload failed/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not touch Piper for subtitles or non-Vietnamese dubbed exports', async () => {
    const prepareVietnamese = vi.fn(async () => undefined);
    const launch = vi.fn(async () => 'queued');

    await launchWithVietnameseClientVoice('subtitles', ['vi'], { prepareVietnamese, launch });
    await launchWithVietnameseClientVoice('dubbed', ['ja'], { prepareVietnamese, launch });
    expect(prepareVietnamese).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('preloads Vietnamese once for a mixed-language dubbed batch then launches once', async () => {
    const prepareVietnamese = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ['vi', 'ja']);

    await launchWithVietnameseClientVoice('dubbed', ['vi', 'ja'], { prepareVietnamese, launch });
    expect(prepareVietnamese).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
