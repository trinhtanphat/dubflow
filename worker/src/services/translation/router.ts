import type { SourceLanguage } from '../../domain/project';
import { isTargetLanguage, type TargetLanguage } from '../../domain/language';
import { isTranslationContextActive, type TranslationContext } from './context';
import type { TranslationItem, TranslationProvider, TranslationResult } from './types';
import { TranslationProviderError } from './types';

export type TranslationMode = 'workers-ai' | 'google' | 'compare' | 'contextual';

export type PersistableTranslationRoute = {
  mode: 'workers-ai' | 'google' | 'contextual';
  primary: TranslationResult[];
  contextRevision: number | null;
};

export type CompareTranslationRoute = {
  mode: 'compare';
  workersAI: TranslationResult[];
  google: TranslationResult[];
  contextRevision: null;
};

export type TranslationRouteResult = PersistableTranslationRoute | CompareTranslationRoute;

function resolveMode(requested: TranslationMode | undefined, context?: TranslationContext): TranslationMode {
  const active = Boolean(context && isTranslationContextActive(context));
  if (requested === undefined) return active ? 'contextual' : 'workers-ai';
  if (active && requested !== 'contextual') {
    throw new TranslationProviderError(
      'TRANSLATION_CONTEXT_UNSUPPORTED',
      'Active translation context requires contextual mode.',
    );
  }
  return requested;
}

function assertTarget(target: unknown): asserts target is TargetLanguage {
  if (!isTargetLanguage(target)) {
    throw new TranslationProviderError(
      'TRANSLATION_TARGET_UNSUPPORTED',
      'Unsupported translation target language.',
    );
  }
}

function assertProviderTarget(provider: TranslationProvider, target: TargetLanguage): void {
  if (!provider.capabilities.targets.includes(target)) {
    throw new TranslationProviderError(
      'TRANSLATION_TARGET_UNSUPPORTED',
      'Selected translation provider does not support the requested target language.',
    );
  }
}

export class TranslationRouter {
  constructor(
    private readonly workersAI: TranslationProvider,
    private readonly google: TranslationProvider,
    private readonly contextual?: TranslationProvider,
  ) {}

  async translate(
    requestedMode: TranslationMode | undefined,
    items: TranslationItem[],
    source: SourceLanguage,
    target: TargetLanguage,
    context?: TranslationContext,
  ): Promise<TranslationRouteResult> {
    assertTarget(target);
    const mode = resolveMode(requestedMode, context);
    if (mode === 'contextual') {
      if (!context || !this.contextual?.capabilities.contextual || !this.contextual.capabilities.available) {
        throw new TranslationProviderError(
          'CONTEXT_TRANSLATION_UNAVAILABLE',
          'Contextual translation provider is unavailable.',
        );
      }
      assertProviderTarget(this.contextual, target);
      return {
        mode,
        primary: await this.contextual.translateBatch(items, source, target, context),
        contextRevision: context.revision,
      };
    }
    if (mode === 'workers-ai') {
      assertProviderTarget(this.workersAI, target);
      return {
        mode,
        primary: await this.workersAI.translateBatch(items, source, target, context),
        contextRevision: null,
      };
    }
    if (mode === 'google') {
      assertProviderTarget(this.google, target);
      return {
        mode,
        primary: await this.google.translateBatch(items, source, target, context),
        contextRevision: null,
      };
    }
    if (mode === 'compare') {
      assertProviderTarget(this.workersAI, target);
      assertProviderTarget(this.google, target);
      if (!this.workersAI.capabilities.available || !this.google.capabilities.available) {
        throw new TranslationProviderError(
          'TRANSLATION_PROVIDER_UNAVAILABLE',
          'Compare mode requires both raw translation providers to be available.',
        );
      }
      const [workersAI, google] = await Promise.all([
        this.workersAI.translateBatch(items, source, target, context),
        this.google.translateBatch(items, source, target, context),
      ]);
      return { mode, workersAI, google, contextRevision: null };
    }
    throw new TranslationProviderError('TRANSLATION_MODE_INVALID', 'Unknown translation mode.');
  }
}
