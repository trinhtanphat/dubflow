// Spike-only adapter: bypass package indices because they eagerly import Web Worker wrappers.
// @ts-expect-error pinned package internal used only by the workerd feasibility spike
import WASMAudioDecoderCommon from '../../../node_modules/@wasm-audio-decoders/common/src/WASMAudioDecoderCommon.js';
// @ts-expect-error pinned package internal used only by the workerd feasibility spike
import EmscriptenWASM from '../../../node_modules/@wasm-audio-decoders/aac/src/EmscriptenWasm.js';
// Wrangler's CompiledWasm rule turns this static import into a precompiled WebAssembly.Module.
// The file is materialized by the Node integration test before wrangler dev starts.
// @ts-expect-error Wrangler provides WebAssembly.Module for CompiledWasm imports
import aacModule from './generated/aac-decoder.wasm';

const AAC_ADTS_BASE64 = '//FgQCif/N4CAExhdmM2MS4xOS4xMDEAAjyrWqpEbUWFMrN++fXValyqk3JEkncSR6pJcv/947q7h7q7J+peu/UvmeNuaeyu6djdk81dw623Dzdxri2aeMusY62z9iiB5PJwOS4//79BUrVWxdnZdxLQbNcZ7bcqynHYm5YnHWGxVmexuKuNisNasNysNana1Gxz62fWylUpVKVSlUpVKVSlUpVKVRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRJRLkkokokpwU4KcFRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRREhEIiISEMiIZIYiJAEhgx6PAh3aO7h1KSxhVKOph0SWZiSqOhicIOhxywKhwzIKWwVgOpw/hP3d2A/J/xOA//FgQCy//AD0ntrKMudQm1DLC9NuOiQm3XTEk//r//f/rXGpfHjy758fn/+z/P6i3VxV/X/9b/2daTWtVzV/X/+b/11xqNcarmqdujEnoApbvuxjmLzzzzyXnkvB54QtU5lro3SUmm6RqIxtouMlJxsnuy4LCGxgs8Hiw6mVDBBCilO9zTvTzvTqDEqVPP58/y5sJ5/BidnFVFMM53bzTWcXSkKA7JBIEpuAIy9yRo4ElU3BKpgSNvassEjM87xmRAkTJxMNIkJlIkoekdNJ2NLbUbqjk0sqpuqOTSyqmkjRapMtIstNM0mZSNGkYVVRKZpMtM0WmWqplpmy6tJFoNzKRpSRUmGpM4mkSkycKNJE8JQgpGKJoee88pORNvMSmA/mqEVHUbzSl0FKaTCBHT7slvurmkwHIuFo7aZ7Ez1lnp1s1ZRslImp1tIyUjiqyyaqpFMpZGWQ0uyzOnyxmywIURDg//FgQCdf/AE4n7RN14dv8h+Xr/288N3ehdz/+L9fiand6ACgQQIOa6H8K/RsDdFxhRRu84uMKKNxfPYxQpdNwcPD5YeHywDw+Xy+WAeHy+v5YH/6//9f/fwOn9P6eAdP6f0/p4AdP6f0/p/TwA6f0/p+MRRQI5LjIAAQXGAAASgvJGAAABKVJJRIAAAEoUEk9oAAEpMglGiAAASkRyUWIAABIQiQQgAASKUkQhIYyQxAAAAABJaiSkkkpJIQAAAAAEjnJHMSMYkYpIpSRSAAAAAAAAEiEJEISGMkMZIYyQhAAAAAAAAEhCJCESEIkEJIISQQkghJBAAAAAAAAAAABIACQAEgAJAASAAkABIAMfA//v/4AAAAAAAAAAAAA//v/7/+//v/7/+//v/7/+//gAAAAAAAAAAAADg=';

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function firstAdtsFrame(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 7 || bytes[0] !== 0xff || (bytes[1] & 0xf6) !== 0xf0) {
    throw new Error('AAC_FIXTURE_INVALID: Missing ADTS sync word.');
  }
  const length = ((bytes[3] & 0x03) << 11) | (bytes[4] << 3) | ((bytes[5] & 0xe0) >> 5);
  if (length < 7 || length > bytes.length) throw new Error('AAC_FIXTURE_INVALID: ADTS frame length is invalid.');
  return bytes.subarray(0, length);
}

async function decodeFixture() {
  const common = await new WASMAudioDecoderCommon().instantiate(EmscriptenWASM, aacModule as WebAssembly.Module);
  const frame = firstAdtsFrame(decodeBase64(AAC_ADTS_BASE64));

  const input = common.allocateTypedArray(Math.max(65_536, frame.length), Uint8Array);
  const channels = common.allocateTypedArray(1, Uint32Array);
  const sampleRate = common.allocateTypedArray(1, Uint32Array);
  const samplesDecoded = common.allocateTypedArray(1, Uint32Array);
  const outputBufferPtr = common.allocateTypedArray(1, Uint32Array);
  const outputBufferLen = common.allocateTypedArray(1, Uint32Array);
  const errorStringPtr = common.allocateTypedArray(1, Uint32Array);
  let decoder = 0;
  let outputPtr = 0;

  try {
    input.buf.set(frame);
    decoder = common.wasm.create_decoder(
      0,
      0,
      0,
      channels.ptr,
      sampleRate.ptr,
      samplesDecoded.ptr,
      outputBufferPtr.ptr,
      outputBufferLen.ptr,
      errorStringPtr.ptr,
    );
    if (!decoder) throw new Error('AAC_DECODER_INIT_FAILED');

    common.wasm.decode_frame(decoder, input.ptr, frame.length);
    if (errorStringPtr.buf[0]) throw new Error(`AAC_DECODE_FAILED: ${common.codeToString(errorStringPtr.buf[0])}`);

    outputPtr = outputBufferPtr.buf[0];
    const outputLength = outputBufferLen.buf[0];
    const channelCount = channels.buf[0];
    const decodedSamples = samplesDecoded.buf[0];
    const decodedRate = sampleRate.buf[0];
    if (!outputPtr || !outputLength || !channelCount || !decodedSamples || !decodedRate) {
      throw new Error('AAC_DECODE_EMPTY');
    }

    const output = new Float32Array(common.wasm.HEAP, outputPtr, outputLength);
    if (!output.some((sample: number) => Number.isFinite(sample))) throw new Error('AAC_DECODE_INVALID_PCM');

    return {
      ok: true,
      sampleRate: decodedRate,
      samplesDecoded: decodedSamples,
      channelCount,
    };
  } finally {
    if (outputPtr) common.wasm.free(outputPtr);
    if (decoder) common.wasm.destroy_decoder(decoder);
    common.free();
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/decode') return new Response('Not found', { status: 404 });

    try {
      return Response.json(await decodeFixture(), { status: 200 });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, { status: 500 });
    }
  },
};
