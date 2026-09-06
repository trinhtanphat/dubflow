export type DubbedAudioMode = 'dubbed_only' | 'duck_original' | 'separated_background';

export function parseDubbedAudioMode(value: unknown): DubbedAudioMode | null {
  if (value === undefined) return 'dubbed_only';
  return value === 'dubbed_only' || value === 'duck_original' || value === 'separated_background'
    ? value
    : null;
}
