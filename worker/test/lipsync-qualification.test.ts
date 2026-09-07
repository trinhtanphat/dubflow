import { describe, expect, it } from 'vitest';
import {
  qualifiedSyncLabsApiKey,
  syncLabsLipSyncCapability,
} from '../src/services/lipsync/qualification';

describe('visual lip-sync runtime qualification', () => {
  it('keeps an unconfigured provider unavailable', () => {
    expect(syncLabsLipSyncCapability(undefined, undefined)).toEqual({
      available: false,
      provider: null,
      qualification: 'unavailable',
    });
    expect(qualifiedSyncLabsApiKey(undefined, undefined)).toBeUndefined();
  });

  it('keeps a configured provider unavailable to Workflow execution until explicitly qualified', () => {
    expect(syncLabsLipSyncCapability('sync-secret', undefined)).toEqual({
      available: false,
      provider: 'sync-labs',
      qualification: 'unqualified',
    });
    expect(qualifiedSyncLabsApiKey('sync-secret', undefined)).toBeUndefined();
    expect(qualifiedSyncLabsApiKey('sync-secret', 'false')).toBeUndefined();
    expect(qualifiedSyncLabsApiKey('sync-secret', 'garbage')).toBeUndefined();
  });

  it('exposes a normalized provider key only after explicit runtime qualification', () => {
    expect(syncLabsLipSyncCapability('  sync-secret  ', ' TRUE ')).toEqual({
      available: true,
      provider: 'sync-labs',
      qualification: 'qualified',
    });
    expect(qualifiedSyncLabsApiKey('  sync-secret  ', ' TRUE ')).toBe('sync-secret');
  });

  it('never exposes the provider secret in capability metadata', () => {
    const capability = syncLabsLipSyncCapability('sync-secret', 'true');
    expect(JSON.stringify(capability)).not.toContain('sync-secret');
  });
});
