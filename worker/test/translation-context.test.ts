import { describe, expect, it } from 'vitest';
import {
  MAX_CONTEXT_PAYLOAD_BYTES,
  MAX_GLOSSARY_ENTRIES,
  TRANSLATION_STYLES,
  isTranslationContextActive,
  normalizeGlossaryKey,
  type TranslationContext,
} from '../src/services/translation/context';

describe('Phase 4A translation context primitives', () => {
  it('normalizes glossary keys deterministically', () => {
    expect(normalizeGlossaryKey('  Ａcme  ', false)).toBe('acme');
    expect(normalizeGlossaryKey('  Ａcme  ', true)).toBe('Acme');
  });

  it('locks the canonical styles and context limits', () => {
    expect(TRANSLATION_STYLES).toEqual(['neutral', 'natural', 'formal', 'casual', 'cinematic']);
    expect(MAX_GLOSSARY_ENTRIES).toBe(200);
    expect(MAX_CONTEXT_PAYLOAD_BYTES).toBe(128 * 1024);
  });

  it('treats neutral empty context as inactive and style/glossary context as active', () => {
    const neutral: TranslationContext = { revision: 1, style: 'neutral', glossary: [] };
    expect(isTranslationContextActive(neutral)).toBe(false);
    expect(isTranslationContextActive({ ...neutral, style: 'formal' })).toBe(true);
    expect(isTranslationContextActive({
      ...neutral,
      glossary: [{
        id: 'g1', projectId: 'p1', sourceTerm: 'Acme', preferredTranslation: 'Acme', note: null,
        caseSensitive: false, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
      }],
    })).toBe(true);
  });
});
