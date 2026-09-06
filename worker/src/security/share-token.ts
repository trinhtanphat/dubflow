function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export async function hashShareToken(token: string): Promise<string> {
  const normalized = token.trim();
  if (!normalized) throw new Error('Share token must not be empty.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createShareToken(): Promise<{
  token: string;
  tokenHash: string;
  tokenHint: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(bytes);
  return {
    token,
    tokenHash: await hashShareToken(token),
    tokenHint: token.slice(-8),
  };
}
