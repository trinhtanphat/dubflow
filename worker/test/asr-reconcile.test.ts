import { describe, expect, it } from 'vitest';
import type { StitchedAsrSegment } from '../src/services/asr/stitch';
import { reconcileSpeakerIds, type ExistingSpeakerCoverage } from '../src/services/asr/reconcile';

function segment(speakerId: string | null, startMs: number, endMs: number, id = `${speakerId}-${startMs}`): StitchedAsrSegment {
  return {
    id,
    projectId: 'p1',
    chunkId: 'c0',
    startMs,
    endMs,
    text: id,
    speakerId,
  };
}

describe('ASR rerun speaker reconciliation', () => {
  it('reuses one unique historical speaker with at least two seconds of overlap', () => {
    const out = reconcileSpeakerIds([
      segment('spk_fresh', 10_000, 14_000),
    ], [
      { speakerId: 'spk_existing', ranges: [{ startMs: 9_000, endMs: 14_000 }] },
    ]);

    expect(out[0].speakerId).toBe('spk_existing');
  });

  it('does not reuse historical identity below the two-second threshold', () => {
    const out = reconcileSpeakerIds([
      segment('spk_fresh', 10_000, 11_500),
    ], [
      { speakerId: 'spk_existing', ranges: [{ startMs: 10_000, endMs: 11_500 }] },
    ]);

    expect(out[0].speakerId).toBe('spk_fresh');
  });

  it('does not reuse identity when one fresh cluster ties between historical speakers', () => {
    const out = reconcileSpeakerIds([
      segment('spk_fresh', 10_000, 14_000),
    ], [
      { speakerId: 'spk_old_a', ranges: [{ startMs: 10_000, endMs: 12_000 }] },
      { speakerId: 'spk_old_b', ranges: [{ startMs: 12_000, endMs: 14_000 }] },
    ]);

    expect(out[0].speakerId).toBe('spk_fresh');
  });

  it('allows only the strongest fresh cluster to claim one historical speaker', () => {
    const out = reconcileSpeakerIds([
      segment('spk_fresh_a', 0, 4_000, 'a'),
      segment('spk_fresh_b', 5_000, 8_000, 'b'),
    ], [
      { speakerId: 'spk_existing', ranges: [{ startMs: 0, endMs: 4_000 }, { startMs: 5_000, endMs: 8_000 }] },
    ]);

    expect(out.find((item) => item.id === 'a')?.speakerId).toBe('spk_existing');
    expect(out.find((item) => item.id === 'b')?.speakerId).toBe('spk_fresh_b');
  });

  it('lets neither equal claimant steal one historical speaker', () => {
    const fresh = [
      segment('spk_fresh_a', 0, 3_000, 'a'),
      segment('spk_fresh_b', 5_000, 8_000, 'b'),
    ];
    const existing: ExistingSpeakerCoverage[] = [
      { speakerId: 'spk_existing', ranges: [{ startMs: 0, endMs: 3_000 }, { startMs: 5_000, endMs: 8_000 }] },
    ];

    const out = reconcileSpeakerIds(fresh, existing);
    expect(out.find((item) => item.id === 'a')?.speakerId).toBe('spk_fresh_a');
    expect(out.find((item) => item.id === 'b')?.speakerId).toBe('spk_fresh_b');
  });

  it('is deterministic across segment and coverage input ordering', () => {
    const fresh = [
      segment('spk_fresh_a', 0, 4_000, 'a'),
      segment('spk_fresh_b', 8_000, 12_000, 'b'),
    ];
    const existing: ExistingSpeakerCoverage[] = [
      { speakerId: 'spk_old_a', ranges: [{ startMs: 0, endMs: 4_000 }] },
      { speakerId: 'spk_old_b', ranges: [{ startMs: 8_000, endMs: 12_000 }] },
    ];

    expect(reconcileSpeakerIds(fresh, existing)).toEqual(
      reconcileSpeakerIds([...fresh].reverse(), [...existing].reverse()).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
