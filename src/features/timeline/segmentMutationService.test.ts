import { describe, expect, it } from 'vitest';
import type { EditorMutation, SplitMutation, TimingMutation } from '../../app/editorHistory';
import type { CloudSegment, RestoreSegmentInput, SegmentPatch } from '../transcript/segmentApi';
import type { Segment } from './types';
import {
  commitSegmentSplit,
  commitSegmentTiming,
  persistRedo,
  persistUndo,
  type SegmentMutationDeps,
} from './segmentMutationService';

const before: Segment = {
  id: 's1',
  speakerId: 'unassigned',
  startMs: 1_000,
  endMs: 3_000,
  sourceText: 'hello beautiful world',
  translatedText: 'xin chao the gioi',
  version: 2,
};

function cloud(segment: Segment, overrides: Partial<CloudSegment> = {}): CloudSegment {
  return {
    id: segment.id,
    projectId: 'project-1',
    speakerId: segment.speakerId === 'unassigned' ? null : segment.speakerId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    translationEngine: 'workers-ai',
    translationStatus: 'completed',
    voiceStatus: 'pending',
    version: segment.version,
    splitParentId: null,
    ...overrides,
  };
}

function makeDeps() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let splitChildId = 'worker-child-1';
  const deps: SegmentMutationDeps = {
    async patchSegment(projectId: string, segmentId: string, expectedVersion: number, patch: SegmentPatch) {
      calls.push({ method: 'patchSegment', args: [projectId, segmentId, expectedVersion, patch] });
      return cloud({ ...before, ...patch, speakerId: before.speakerId } as Segment, { version: expectedVersion + 1 });
    },
    async splitSegment(projectId: string, segmentId: string, playheadMs: number) {
      calls.push({ method: 'splitSegment', args: [projectId, segmentId, playheadMs] });
      const left = cloud({ ...before, endMs: playheadMs, sourceText: 'hello beautiful', translatedText: 'xin chao' }, { version: 3 });
      const right = cloud(
        { ...before, id: splitChildId, startMs: playheadMs, sourceText: 'world', translatedText: 'the gioi', version: 1 },
        { splitParentId: segmentId, version: 1 },
      );
      return { left, right };
    },
    async restoreSplit(
      projectId: string,
      segmentId: string,
      childSegmentId: string,
      original: RestoreSegmentInput,
    ) {
      calls.push({ method: 'restoreSplit', args: [projectId, segmentId, childSegmentId, original] });
      return cloud({
        id: segmentId,
        speakerId: original.speakerId ?? 'unassigned',
        startMs: original.startMs,
        endMs: original.endMs,
        sourceText: original.sourceText,
        translatedText: original.translatedText,
        version: 4,
      }, { version: 4 });
    },
  };
  return {
    deps,
    calls,
    setSplitChildId(value: string) { splitChildId = value; },
  };
}

describe('segment mutation service', () => {
  it('persists timing first with the canonical expected revision and returns the persisted revision', async () => {
    const { deps, calls } = makeDeps();
    const mutation = await commitSegmentTiming('project-1', before, { startMs: 1_200, endMs: 3_200 }, deps);

    expect(calls).toEqual([
      { method: 'patchSegment', args: ['project-1', 's1', 2, { startMs: 1_200, endMs: 3_200 }] },
    ]);
    expect(mutation).toEqual({
      kind: 'timing',
      segmentId: 's1',
      before,
      after: { ...before, startMs: 1_200, endMs: 3_200, version: 3 },
    });
  });

  it('commits a split with canonical Worker-generated child id', async () => {
    const { deps } = makeDeps();
    const mutation = await commitSegmentSplit('project-1', before, 2_000, deps);

    expect(mutation.kind).toBe('split');
    expect(mutation.originalBefore).toEqual(before);
    expect(mutation.leftAfter).toMatchObject({ id: 's1', endMs: 2_000, speakerId: 'unassigned', version: 3 });
    expect(mutation.rightAfter).toMatchObject({ id: 'worker-child-1', startMs: 2_000, speakerId: 'unassigned', version: 1 });
  });

  it('uses the last canonical timing revision for inverse persistence', async () => {
    const { deps, calls } = makeDeps();
    const timing: TimingMutation = {
      kind: 'timing', segmentId: 's1', before, after: { ...before, startMs: 1_200, endMs: 3_200, version: 3 },
    };
    const split: SplitMutation = await commitSegmentSplit('project-1', before, 2_000, deps);
    calls.length = 0;

    await persistUndo('project-1', timing, deps);
    await persistUndo('project-1', split, deps);

    expect(calls[0]).toEqual({
      method: 'patchSegment',
      args: ['project-1', 's1', 3, { startMs: 1_000, endMs: 3_000 }],
    });
    expect(calls[1]).toEqual({
      method: 'restoreSplit',
      args: ['project-1', 's1', 'worker-child-1', {
        startMs: 1_000,
        endMs: 3_000,
        sourceText: 'hello beautiful world',
        translatedText: 'xin chao the gioi',
        speakerId: null,
      }],
    });
  });

  it('refreshes split history with the new Worker child id on redo', async () => {
    const fixture = makeDeps();
    const originalMutation = await commitSegmentSplit('project-1', before, 2_000, fixture.deps);
    fixture.setSplitChildId('worker-child-2');
    fixture.calls.length = 0;

    const replayed = await persistRedo('project-1', originalMutation, fixture.deps) as SplitMutation;

    expect(fixture.calls).toEqual([
      { method: 'splitSegment', args: ['project-1', 's1', 2_000] },
    ]);
    expect(replayed.rightAfter.id).toBe('worker-child-2');
    expect(replayed.originalBefore).toEqual(before);
  });

  it('uses the stored pre-edit revision for the current timing redo contract', async () => {
    const fixture = makeDeps();
    const mutation: EditorMutation = {
      kind: 'timing', segmentId: 's1', before, after: { ...before, startMs: 1_200, endMs: 3_200, version: 3 },
    };

    const replayed = await persistRedo('project-1', mutation, fixture.deps);

    expect(fixture.calls).toEqual([
      { method: 'patchSegment', args: ['project-1', 's1', 2, { startMs: 1_200, endMs: 3_200 }] },
    ]);
    expect(replayed).toEqual(mutation);
  });
});
