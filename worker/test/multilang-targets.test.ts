import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { parseBatchTargetLanguages, parseTargetLanguage } from '../src/domain/target-language';
import { createProjectTargetRoutes } from '../src/routes/project-targets';
import { WorkersAITranslationProvider } from '../src/services/translation/workers-ai';

describe('Phase 4C target-language contracts', () => {
  it('defaults omitted language to Vietnamese and bounds batch requests to four distinct targets', () => {
    expect(parseTargetLanguage(undefined)).toBe('vi');
    expect(parseBatchTargetLanguages(['ja', 'vi', 'ja'])).toEqual(['ja', 'vi']);
    expect(() => parseTargetLanguage('fr')).toThrow('Unsupported target language');
    expect(() => parseBatchTargetLanguages(['vi', 'en', 'ja', 'ko', 'zh'])).toThrow('at most 4');
  });

  it('allows a project to enable all five supported targets even though one batch is capped at four', async () => {
    const saved: string[][] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/projects', createProjectTargetRoutes({
      makeProjects: () => ({
        async getByIdForUser() { return { id: 'p1', userId: 'dev-user' }; },
      }) as never,
      makeMultilang: () => ({
        async replaceTargets(_projectId: string, _userId: string, targets: string[]) {
          saved.push(targets);
          return targets;
        },
      }) as never,
    }));

    const response = await app.request('/api/projects/p1/targets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetLanguages: ['vi', 'en', 'ja', 'ko', 'zh'] }),
    }, {} as Env);

    expect(response.status).toBe(200);
    expect(saved).toEqual([['vi', 'en', 'ja', 'ko', 'zh']]);
  });

  it('Workers AI forwards a non-Vietnamese target instead of rejecting it', async () => {
    const calls: unknown[] = [];
    const provider = new WorkersAITranslationProvider({
      async run(_model: string, input: unknown) {
        calls.push(input);
        return { translated_text: 'こんにちは' };
      },
    });

    const result = await provider.translateBatch([{ id: 's1', text: 'hello' }], 'en', 'ja' as never);
    expect(result).toEqual([{ id: 's1', text: 'こんにちは', provider: 'workers-ai' }]);
    expect(calls).toEqual([{ text: 'hello', source_lang: 'english', target_lang: 'japanese' }]);
  });
});
