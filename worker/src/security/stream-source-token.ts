const encoder = new TextEncoder();

function tokenMessage(projectId: string, objectKey: string, expires: number): Uint8Array {
  return encoder.encode(`${projectId}\n${objectKey}\n${expires}`);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  const normalized = secret.trim();
  if (!normalized) throw new Error('Stream source signing secret is missing.');
  return crypto.subtle.importKey(
    'raw',
    arrayBuffer(encoder.encode(normalized)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export async function createStreamSourceToken(
  secret: string,
  projectId: string,
  objectKey: string,
  expires: number,
): Promise<string> {
  if (!Number.isInteger(expires) || expires <= 0) throw new Error('Stream source expiry is invalid.');
  if (!objectKey.startsWith(`projects/${projectId}/`)) throw new Error('Stream source object is outside the project.');
  const key = await importSigningKey(secret);
  return bytesToHex(await crypto.subtle.sign('HMAC', key, arrayBuffer(tokenMessage(projectId, objectKey, expires))));
}

export async function verifyStreamSourceToken(input: {
  secret: string;
  projectId: string;
  objectKey: string;
  expires: number;
  signature: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const { secret, projectId, objectKey, expires, signature } = input;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expires) || expires <= nowSeconds) return false;
  if (!objectKey.startsWith(`projects/${projectId}/`)) return false;
  const signatureBytes = hexToBytes(signature);
  if (!signatureBytes) return false;
  try {
    const key = await importSigningKey(secret);
    return crypto.subtle.verify(
      'HMAC',
      key,
      arrayBuffer(signatureBytes),
      arrayBuffer(tokenMessage(projectId, objectKey, expires)),
    );
  } catch {
    return false;
  }
}
