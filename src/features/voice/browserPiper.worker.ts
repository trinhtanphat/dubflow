import { TtsSession } from '@mintplex-labs/piper-tts-web';
import { wavToClientPcm } from './clientPcm';
import {
  VIETNAMESE_PIPER_VOICE,
  type PiperWorkerRequest,
  type PiperWorkerResponse,
} from './browserPiperProtocol';

type WorkerScope = {
  postMessage: (message: PiperWorkerResponse, transfer?: Transferable[]) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<PiperWorkerRequest>) => void,
  ) => void;
};

const workerScope = self as unknown as WorkerScope;
let sessionPromise: Promise<TtsSession> | null = null;

function postProgress(progress: { loaded?: number; total?: number }) {
  workerScope.postMessage({
    type: 'progress',
    loaded: typeof progress.loaded === 'number' ? progress.loaded : undefined,
    total: typeof progress.total === 'number' ? progress.total : undefined,
  });
}

function ensureSession(): Promise<TtsSession> {
  if (!sessionPromise) {
    sessionPromise = TtsSession.create({
      voiceId: VIETNAMESE_PIPER_VOICE,
      progress: postProgress,
    });
  }
  return sessionPromise;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Browser Piper failed.';
}

async function initialize() {
  try {
    await ensureSession();
    workerScope.postMessage({ type: 'ready' });
  } catch (error) {
    sessionPromise = null;
    workerScope.postMessage({
      type: 'error',
      code: 'PIPER_INIT_FAILED',
      message: errorMessage(error),
    });
  }
}

async function synthesize(requestId: string, text: string) {
  try {
    const session = await ensureSession();
    const wav = await session.predict(text);
    const pcm = wavToClientPcm(await wav.arrayBuffer());
    const transferable = Uint8Array.from(pcm).buffer;
    workerScope.postMessage({ type: 'result', requestId, pcm: transferable }, [transferable]);
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId,
      code: 'PIPER_SYNTHESIS_FAILED',
      message: errorMessage(error),
    });
  }
}

workerScope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'init') {
    void initialize();
    return;
  }
  if (request.type === 'synthesize') void synthesize(request.requestId, request.text);
});
