import { AACDecoder } from '@wasm-audio-decoders/aac';

const AAC_ADTS_BASE64 = '//FgQCif/N4CAExhdmM2MS4xOS4xMDEAAjyrWqpEbUWFMrN++fXValyqk3JEkncSR6pJcv/947q7h7q7J+peu/UvmeNuaeyu6djdk81dw623Dzdxri2aeMusY62z9iiB5PJwOS4//79BUrVWxdnZdxLQbNcZ7bcqynHYm5YnHWGxVmexuKuNisNasNysNana1Gxz62fWylUpVKVSlUpVKVSlUpVKVRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRLkkokokpwU4KcFRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRREhEIiISEMiIZIYiJAEhgx6PAh3aO7h1KSxhVKOph0SWZiSqOhicIOhxywKhwzIKWwVgOpw/hP3d2A/J/xOA//FgQCy//AD0ntrKMudQm1DLC9NuOiQm3XTEk//r//f/rXGpfHjy758fn/+z/P6i3VxV/X/9b/2daTWtVzV/X/+b/11xqNcarmqdujEnoApbvuxjmLzzzzyXnkvB54QtU5lro3SUmm6RqIxtouMlJxsnuy4LCGxgs8Hiw6mVDBBCilO9zTvTzvTqDEqVPP58/y5sJ5/BidnFVFMM53bzTWcXSkKA7JBIEpuAIy9yRo4ElU3BKpgSNvassEjM87xmRAkTJxMNIkJlIkoekdNJ2NLbUbqjk0sqpuqOTSyqmkjRapMtIstNM0mZSNGkYVVRKZpMtM0WmWqplpmy6tJFoNzKRpSRUmGpM4mkSkycKNJE8JQgpGKJoee88pORNvMSmA/mqEVHUbzSl0FKaTCBHT7slvurmkwHIuFo7aZ7Ez1lnp1s1ZRslImp1tIyUjiqyyaqpFMpZGWQ0uyzOnyxmywIURDg//FgQCdf/AE4n7RN14dv8h+Xr/288N3ehdz/+L9fiand6ACgQQIOa6H8K/RsDdFxhRRu84uMKKNxfPYxQpdNwcPD5YeHywDw+Xy+WAeHy+v5YH/6//9f/fwOn9P6eAdP6f0/p4AdP6f0/p/TwA6f0/p+MRRQI5LjIAAQXGAAASgvJGAAABKVJJRIAAAEoUEk9oAAEpMglGiAAASkRyUWIAABIQiQQgAASKUkQhIYyQxAAAAABJaiSkkkpJIQAAAAAEjnJHMSMYkYpIpSRSAAAAAAAAEiEJEISGMkMZIYyQhAAAAAAAAEhCJCESEIkEJIISQQkghJBAAAAAAAAAAABIACQAEgAJAASAAkABIAMfA//v/4AAAAAAAAAAAAA//v/7/+//v/7/+//v/7/+//gAAAAAAAAAAAADg=';

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function decodeFixture() {
  const decoder = new AACDecoder();
  try {
    await decoder.ready;
    const decoded = await decoder.decodeFile(decodeBase64(AAC_ADTS_BASE64));
    return {
      ok: decoded.samplesDecoded > 0 && decoded.channelData.length > 0,
      sampleRate: decoded.sampleRate,
      samplesDecoded: decoded.samplesDecoded,
      channelCount: decoded.channelData.length,
      errors: decoded.errors?.map((error: { message?: string }) => error.message ?? 'decode error') ?? [],
    };
  } finally {
    decoder.free();
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/decode') return new Response('Not found', { status: 404 });

    try {
      const result = await decodeFixture();
      return Response.json(result, { status: result.ok ? 200 : 500 });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, { status: 500 });
    }
  },
};
