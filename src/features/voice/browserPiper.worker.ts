import { TtsSession } from '@mintplex-labs/piper-tts-web';
import { wavToClientPcm } from './clientPcm';
import {
  VIETNAMESE_PIPER_VOICE,
  type PiperWorkerRequest,
  type PiperWorkerResponse,
} from './browserPiperProtocol';

const QUALIFIED_VIETNAMESE_VOICE: 'vi_VN-vais1000-medium' = VIETNAMESE_PIPER_VOICE;

const workerScope = self as unknown as {
  postMessage(message: PiperWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<PiperWorkerRequest>) => void) | null;
};

let session: TtsSession | null = null;
let readyPromise: Promise<void> | null = null;

function postProgress(progress: { loaded: number; total: number }, requestId?: string) {
  workerScope.postMessage({
    type: 'progress',
    ...(requestId ? { requestId } : {}),
    loaded: progress.loaded,
    total: progress.total,
  });
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = TtsSession.create({
      voiceId: QUALIFIED_VIETNAMESE_VOICE,
      progress: (progress) => postProgress(progress),
    }).then((createdSession) => {
      session = createdSession;
    });
  }
  return readyPromise;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Browser Piper failed.';
}

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    void ensureReady()
      .then(() => workerScope.postMessage({ type: 'ready' }))
      .catch((error) => {
        session = null;
        readyPromise = null;
        workerScope.postMessage({ type: 'error', code: 'PIPER_INIT_FAILED', message: errorMessage(error) });
      });
    return;
  }

  const requestId = message.requestId;
  const text = message.text.trim();
  if (!text) {
    workerScope.postMessage({ type: 'error', requestId, code: 'PIPER_TEXT_EMPTY', message: 'Piper synthesis text is empty.' });
    return;
  }

  void ensureReady()
    .then(() => {
      if (!session) throw new Error('Piper session is unavailable after initialization.');
      return session.predict(text);
    })
    .then((wav) => wav.arrayBuffer())
    .then((wavBuffer) => wavToClientPcm(wavBuffer))
    .then((pcm) => {
      const transferable = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      workerScope.postMessage({ type: 'result', requestId, pcm: transferable }, [transferable]);
    })
    .catch((error) => {
      workerScope.postMessage({ type: 'error', requestId, code: 'PIPER_SYNTHESIS_FAILED', message: errorMessage(error) });
    });
};
