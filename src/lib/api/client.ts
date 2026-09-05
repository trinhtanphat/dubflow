export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? 'HTTP_ERROR', body?.error?.message ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
