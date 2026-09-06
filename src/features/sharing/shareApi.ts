import { apiFetch } from '../../lib/api/client';

export type ShareStatus = 'active' | 'expired' | 'revoked';

export type ExportShare = {
  id: string;
  projectId: string;
  tokenHint: string;
  exportObjectKey: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  status: ShareStatus;
};

export type CreateShareResult = {
  share: ExportShare;
  shareUrl: string;
};

export function createShare(projectId: string, expiresInSeconds?: number) {
  return apiFetch<CreateShareResult>(
    `/api/projects/${encodeURIComponent(projectId)}/shares`,
    {
      method: 'POST',
      body: JSON.stringify(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
    },
  );
}

export function listShares(projectId: string) {
  return apiFetch<ExportShare[]>(`/api/projects/${encodeURIComponent(projectId)}/shares`);
}

export function revokeShare(projectId: string, shareId: string) {
  return apiFetch<ExportShare>(
    `/api/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(shareId)}`,
    { method: 'DELETE' },
  );
}
