import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ExportShare } from './shareApi';
import { copyShareLink, SharePanelView } from './SharePanel';

const activeShare: ExportShare = {
  id: 's-active',
  projectId: 'p1',
  tokenHint: 'abcd1234',
  exportObjectKey: 'projects/p1/export/final.mp4',
  expiresAt: '2026-09-13T00:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-09-06T00:00:00.000Z',
  status: 'active',
};

const expiredShare: ExportShare = {
  ...activeShare,
  id: 's-expired',
  status: 'expired',
  expiresAt: '2026-09-05T00:00:00.000Z',
};

const revokedShare: ExportShare = {
  ...activeShare,
  id: 's-revoked',
  status: 'revoked',
  revokedAt: '2026-09-06T01:00:00.000Z',
};

describe('SharePanel', () => {
  it('renders the one-time created link separately from persisted metadata', () => {
    const html = renderToStaticMarkup(
      <SharePanelView
        shares={[activeShare, expiredShare, revokedShare]}
        createdShareUrl="https://studio.test/api/shares/s-active/media?token=one_time_secret"
        loading={false}
        busy={false}
        error=""
        onCreate={() => {}}
        onCopy={() => {}}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('https://studio.test/api/shares/s-active/media?token=one_time_secret');
    expect(html).toContain('Sao chép');
    expect(html).toContain('Đang hoạt động');
    expect(html).toContain('Hết hạn');
    expect(html).toContain('Đã thu hồi');
    expect(html).toContain('Tạo liên kết mới');
    expect(html).not.toContain('tokenHash');
    expect(html).not.toMatch(/Facebook|X\/Twitter|Cộng tác viên|Khám phá công khai/);
  });

  it('does not reconstruct a bearer URL from persisted token hints after reload', () => {
    const html = renderToStaticMarkup(
      <SharePanelView
        shares={[activeShare]}
        createdShareUrl=""
        loading={false}
        busy={false}
        error=""
        onCreate={() => {}}
        onCopy={() => {}}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('abcd1234');
    expect(html).not.toContain('/api/shares/s-active/media?token=');
    expect(html).toContain('Liên kết bí mật chỉ hiển thị một lần khi tạo');
  });

  it('copies only the one-time returned link through the clipboard boundary', async () => {
    const writeText = vi.fn(async () => undefined);
    await copyShareLink('https://studio.test/share?token=secret', { writeText });
    expect(writeText).toHaveBeenCalledWith('https://studio.test/share?token=secret');
  });

  it('rejects copying an empty link instead of inventing one from metadata', async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyShareLink('   ', { writeText })).rejects.toThrow('Share link is unavailable.');
    expect(writeText).not.toHaveBeenCalled();
  });
});
