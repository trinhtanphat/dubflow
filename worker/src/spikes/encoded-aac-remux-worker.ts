import { extractR2LongFormAudioChunks } from '../services/asr/r2-long-form';

const QUALIFICATION_DURATION_MS = 60_000;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/transmux') return new Response('Not found', { status: 404 });

    const source = url.searchParams.get('source') ?? '';
    try {
      const chunks = await extractR2LongFormAudioChunks(source, QUALIFICATION_DURATION_MS);
      const firstChunkBytes = new Uint8Array(chunks[0]?.audio ?? new ArrayBuffer(0));
      return Response.json({
        ok: true,
        chunkCount: chunks.length,
        offsetsMs: chunks.map((chunk) => chunk.offsetMs),
        durationsMs: chunks.map((chunk) => chunk.durationMs),
        byteLengths: chunks.map((chunk) => chunk.audio.byteLength),
        firstBoxType: firstChunkBytes.byteLength >= 8
          ? new TextDecoder().decode(firstChunkBytes.slice(4, 8))
          : null,
      });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, { status: 500 });
    }
  },
};
