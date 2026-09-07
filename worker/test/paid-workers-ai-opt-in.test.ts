import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AiBinding } from '../src/cloudflare/ai';
import { checkReadiness } from '../src/routes/readiness';
import { createAsrProvider, asrCapabilities } from '../src/services/asr/router';
import { WorkersAITranslationProvider } from '../src/services/translation/workers-ai';
import { ContextualWorkersAITranslationProvider } from '../src/services/translation/contextual';

// TDD RED carrier: production code remains untouched until these behaviors fail for the intended reason.
function aiSpy() {
  let calls = 0;
  const ai = {
    async run(_model: string, input: unknown) {
      calls += 1;
      if (input && typeof input === 'object' && Array.isArray((input as { messages?: unknown[] }).messages)) {
        return { response: JSON.stringify({ translations: [{ id: 'segment-1', text: 'xin chao' }] }) };
      }
      if (input && typeof input === 'object' && 'audio' in input) {
        return { text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] };
      }
      return { translated_text: 'xin chao' };
    },
  } satisfies AiBinding;
  return { ai, calls: () => calls };
}

const context = { revision: 1, style: 'neutral' as const, glossary: [] };
const unavailableDb = {
  prepare() {
    throw new Error('db unavailable');
  },
};

function compactSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

describe('Workers AI paid opt-in', () => {
  it('fails ASR closed before invoking Workers AI when opt-in is absent', async () => {
    const spy = aiSpy();
    const provider = createAsrProvider(spy.ai, undefined, undefined);

    await expect(provider.transcribe(new Uint8Array([1, 2, 3]).buffer, { sourceLanguage: 'en' }))
      .rejects.toMatchObject({ code: 'WORKERS_AI_PAID_OPT_IN_REQUIRED' });
    expect(spy.calls()).toBe(0);
    expect(asrCapabilities(undefined, undefined)).toMatchObject({ provider: 'unavailable' });
  });

  it('allows ASR Workers AI only with explicit paid opt-in', async () => {
    const spy = aiSpy();
    const provider = (createAsrProvider as any)(spy.ai, undefined, undefined, 'true');

    await expect(provider.transcribe(new Uint8Array([1, 2, 3]).buffer, { sourceLanguage: 'en' }))
      .resolves.toMatchObject({ text: 'hello' });
    expect(spy.calls()).toBe(1);
    expect((asrCapabilities as any)(undefined, undefined, 'true')).toMatchObject({
      provider: 'workers-ai-whisper-large-v3-turbo',
    });
  });

  it('fails raw translation closed before invoking Workers AI when opt-in is absent', async () => {
    const spy = aiSpy();
    const provider = new WorkersAITranslationProvider(spy.ai);

    await expect(provider.translateBatch([{ id: 'segment-1', text: 'hello' }], 'en', 'vi', context))
      .rejects.toMatchObject({ code: 'WORKERS_AI_PAID_OPT_IN_REQUIRED' });
    expect(spy.calls()).toBe(0);
    expect(provider.capabilities.available).toBe(false);
  });

  it('allows raw translation only with explicit paid opt-in', async () => {
    const spy = aiSpy();
    const provider = new (WorkersAITranslationProvider as any)(spy.ai, true);

    await expect(provider.translateBatch([{ id: 'segment-1', text: 'hello' }], 'en', 'vi', context))
      .resolves.toEqual([{ id: 'segment-1', text: 'xin chao', provider: 'workers-ai' }]);
    expect(spy.calls()).toBe(1);
  });

  it('fails contextual translation closed before invoking Workers AI when opt-in is absent', async () => {
    const spy = aiSpy();
    const provider = new ContextualWorkersAITranslationProvider(spy.ai, '@cf/example/context-model');

    expect(provider.capabilities.available).toBe(false);
    await expect(provider.translateBatch([{ id: 'segment-1', text: 'hello' }], 'en', 'vi', context))
      .rejects.toMatchObject({ code: 'WORKERS_AI_PAID_OPT_IN_REQUIRED' });
    expect(spy.calls()).toBe(0);
  });

  it('allows contextual translation only with explicit paid opt-in', async () => {
    const spy = aiSpy();
    const provider = new (ContextualWorkersAITranslationProvider as any)(spy.ai, '@cf/example/context-model', true);

    await expect(provider.translateBatch([{ id: 'segment-1', text: 'hello' }], 'en', 'vi', context))
      .resolves.toEqual([{ id: 'segment-1', text: 'xin chao', provider: 'workers-ai-contextual' }]);
    expect(spy.calls()).toBe(1);
  });

  it('reports Workers AI disabled in readiness without changing infrastructure readiness semantics', async () => {
    const disabled = await (checkReadiness as any)(unavailableDb, undefined, undefined, undefined, undefined);
    expect(disabled).toMatchObject({
      database: 'unavailable',
      asr: { provider: 'unavailable' },
      inference: { workersAI: 'disabled' },
    });

    const enabled = await (checkReadiness as any)(unavailableDb, undefined, undefined, undefined, 'true');
    expect(enabled).toMatchObject({
      database: 'unavailable',
      asr: { provider: 'workers-ai-whisper-large-v3-turbo' },
      inference: { workersAI: 'enabled' },
    });
  });

  it('propagates the explicit Workers AI opt-in through every production inference entrypoint', () => {
    const dubbing = compactSource('../src/workflows/DubbingWorkflow.ts');
    const language = compactSource('../src/workflows/LanguageTranslationWorkflow.ts');
    const route = compactSource('../src/routes/translation.ts');

    expect(dubbing).toContain('paidWorkersAiEnabled(this.env.PAID_WORKERS_AI_ENABLED)');
    expect(dubbing).toContain('this.env.PAID_DEEPGRAM_ASR_ENABLED, this.env.PAID_WORKERS_AI_ENABLED');
    expect(language).toContain('paidWorkersAiEnabled(this.env.PAID_WORKERS_AI_ENABLED)');
    expect(route).toContain('paidWorkersAiEnabled(env.PAID_WORKERS_AI_ENABLED)');
  });
});
