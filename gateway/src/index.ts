interface Env {
  BACKEND_ORIGIN?: string;
}

const PUBLIC_ORIGIN = 'https://yupvox.qs3d.site';

function resolveBackendOrigin(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('BACKEND_ORIGIN is not configured.');
  }

  const url = new URL(value.trim());
  if (url.protocol !== 'https:') {
    throw new Error('BACKEND_ORIGIN must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('BACKEND_ORIGIN must be an origin only.');
  }
  if (url.origin === PUBLIC_ORIGIN) {
    throw new Error('BACKEND_ORIGIN must not point back to the public gateway.');
  }
  return url.origin;
}

function unavailable(message: string): Response {
  return Response.json(
    { ok: false, error: 'BACKEND_ORIGIN_UNAVAILABLE', message },
    {
      status: 503,
      headers: {
        'cache-control': 'no-store',
      },
    },
  );
}

function rewriteLocation(location: string, backendOrigin: string): string {
  try {
    const target = new URL(location, backendOrigin);
    if (target.origin !== backendOrigin) return location;
    const publicTarget = new URL(`${target.pathname}${target.search}${target.hash}`, PUBLIC_ORIGIN);
    return publicTarget.toString();
  } catch {
    return location;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let backendOrigin: string;
    try {
      backendOrigin = resolveBackendOrigin(env.BACKEND_ORIGIN);
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }

    const incoming = new URL(request.url);
    const upstreamUrl = new URL(`${incoming.pathname}${incoming.search}`, backendOrigin);
    const upstreamRequest = new Request(upstreamUrl.toString(), request);
    const forwardedHeaders = new Headers(upstreamRequest.headers);
    forwardedHeaders.set('x-forwarded-host', incoming.host);
    forwardedHeaders.set('x-forwarded-proto', 'https');

    const response = await fetch(new Request(upstreamRequest, {
      headers: forwardedHeaders,
      redirect: 'manual',
    }));

    const responseHeaders = new Headers(response.headers);
    const location = responseHeaders.get('location');
    if (location) {
      responseHeaders.set('location', rewriteLocation(location, backendOrigin));
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
