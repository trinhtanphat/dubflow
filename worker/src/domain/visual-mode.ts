export type VisualMode = 'standard' | 'lip_sync';

export function parseVisualMode(value: unknown): VisualMode | null {
  if (value === undefined || value === null) return 'standard';
  return value === 'standard' || value === 'lip_sync' ? value : null;
}
