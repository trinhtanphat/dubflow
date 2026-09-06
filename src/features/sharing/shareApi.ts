import { apiFetch } from '../../lib/api/client';

export type ShareStatus = 'active' | 'expired' | 'revoked';

export type ExportShare = {
  id: string;
  projectId: string;
  exportId?: string | null;
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

export function createShare(projectId: string, expiresInSeconds?: number, exportId?: string) {
  const body: { expiresInSeconds?: number; exportId?: string } = {};
  if (expiresInSeconds !== undefined) body.expiresInSeconds = expiresInSeconds;
  if (exportId !== undefined) body.exportId = exportId;
  return apiFetch<CreateShareResult>(
    `/api/projects/${encodeURIComponent(projectId)}/shares`,
    {
      method: 'POST',
      body: JSON.stringify(body),
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
