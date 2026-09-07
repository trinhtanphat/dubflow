export type LipSyncQualification = 'qualified' | 'unqualified' | 'unavailable';

export type LipSyncCapability = {
  available: boolean;
  provider: 'sync-labs' | null;
  qualification: LipSyncQualification;
};

function normalizedApiKey(apiKey?: string): string | undefined {
  const value = apiKey?.trim();
  return value ? value : undefined;
}

function qualificationEnabled(value?: string): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function syncLabsLipSyncCapability(
  apiKey?: string,
  qualificationFlag?: string,
): LipSyncCapability {
  const configured = Boolean(normalizedApiKey(apiKey));
  if (!configured) {
    return { available: false, provider: null, qualification: 'unavailable' };
  }

  const qualified = qualificationEnabled(qualificationFlag);
  return {
    available: qualified,
    provider: 'sync-labs',
    qualification: qualified ? 'qualified' : 'unqualified',
  };
}

export function qualifiedSyncLabsApiKey(
  apiKey?: string,
  qualificationFlag?: string,
): string | undefined {
  if (!syncLabsLipSyncCapability(apiKey, qualificationFlag).available) return undefined;
  return normalizedApiKey(apiKey);
}
