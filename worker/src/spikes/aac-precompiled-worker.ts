// Spike-only adapter: bypass package indices because they eagerly import Web Worker wrappers.
// @ts-expect-error pinned package internal used only by the workerd feasibility spike
import WASMAudioDecoderCommon from '../../../node_modules/@wasm-audio-decoders/common/src/WASMAudioDecoderCommon.js';
// @ts-expect-error pinned package internal used only by the workerd feasibility spike
import EmscriptenWASM from '../../../node_modules/@wasm-audio-decoders/aac/src/EmscriptenWasm.js';
// Wrangler's CompiledWasm rule turns this static import into a precompiled WebAssembly.Module.
// The file is materialized by the Node integration test before wrangler dev starts.
// @ts-expect-error Wrangler provides WebAssembly.Module for CompiledWasm imports
import aacModule from './generated/aac-decoder.wasm';

// FFmpeg 7.1.5, AAC-LC mono 16 kHz ADTS fixture. Header chain is structurally exact:
// frame lengths 323 + 393 + 301 = 1017 bytes with every next sync at the declared boundary.
const AAC_ADTS_BASE64 = '//FgQCh//N4CAExhdmM2MS4xOS4xMDEAAjyrWqoIjUWFVc3v3z66rUl1Um4kTnrlEPcB/+Y7q7h7q7J2NxbxtxbpLRukuLZ6nmmqd1tuHm7jXFs08ZdYx1tn7FEDyeTgclx//36CpWqti7Oy7iWg2a4z225VlOOxNyxOOsNirM9cZ6sz1ZjrDcrDcrDWo2OfY59bKVSlUpVKVSlUpVKVSlUpVElElElElElElElElElElElElElElElElElElElElElElElElElElElElElSyyyy/c/k3yb81vW9SyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyykFnJsQQWcmxRBSCa0EFoJrOQYkmtJBSCa0kFIJsWQSkmlBBSCakEFIJrUQSkmpJBSSalEEqJoSQSkmlJBKiZjEFJJpTz/8WBAMT/8APSe2soy512oZcircdISVuukb/+v/9/95xpxeR58bz/+L+fxC3GlR9f/1v/Z1pNa4zmq+P/9H/rrq41xquap26KCMG3fsB/t00kcbdGB+IUt33YxzF55555LzzHnnnntE10Pf0oj4xn4htouMlJxsnuy4LCGxgs8G9hsZUMCUKKU73yne5p3p1KeTOc6nvp8vlPsH0+j3y5tiAdt535c3MdFAXRuGxUhUUcZOjgU37zgtKSlCt4EpuAIy9yRo4ElU3BKpgSNvassEjM87xmRAkTJxMNIkJlIkoekdNJ2NLKo3VHJpZVTdUcmllZMpGi1SZaZZaaotUaUNGkFJqjSZaucrY0aTJVVRaZ/N9P/Pp6364YxLWFquuWpaTN1JsqJWFmqJdCkXLaJgT+khaUTjgNySlf/qXb+jwaykBV5BgYYRuupC2vCQUUgjdxRLF8ANJgORcLR20z2cz2JnpFs1ZSLZq6azzE1GtnnFQLJ5KMjQibc9TfDgofYTV4uVCXHiPD/8WBAJb/8ATiftE3Hh6/yH5ev/L2l5fFRNcZ//F+Pqa2lgBQIIEHNdDiFfo13qdYwoo3ecXGNFLpt15MX8fhh4fLDw+WAff+H4fLD/9f/+vA/5/+/9PA6f0/p4B0/p/T+ngB0/p/T+fpiYHT+fEIooEclxkAAILjAAAJNXgRAAAJSpJKJAAAAlCgkntAAAlJkEo0QAACSDkjFAAAkUhIgwAAJFKSIQkMZIYgAAAAAkc5I5iRjEilAAAAACRSEiEJDGSGMkMRIQgAAAAAAACQhEghJBCSCEkABIAAAAAAAAACQAEgA//v/7/+//v/7/yAAAAAAAAAAD/N/m/zf5v83+b/N/m/zfrgAAAAAAAAAAAAD9d+u/Xfrv13679d+u/XfrgAAAAAAAAAAAADg';

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
