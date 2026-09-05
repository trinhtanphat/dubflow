import { describe, expect, it } from 'vitest';
import type { EditorMutation, FieldMutation, SplitMutation, TimingMutation } from '../../app/editorHistory';
import type { CloudSegment, RestoreSegmentInput, SegmentPatch } from '../transcript/segmentApi';
import type { Segment, StudioProject } from './types';
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

function projectWith(...segments: Segment[]): StudioProject {
  return {
    id: 'project-1',
    title: 'Project',
    durationMs: 10_000,
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    speakers: [{ id: 'sp1', name: 'Speaker', label: 'SP', share: 1 }],
    segments,
  };
}

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
      const next: Segment = {
        ...before,
        id: segmentId,
        sourceText: patch.sourceText ?? before.sourceText,
        translatedText: patch.translatedText ?? before.translatedText,
        speakerId: patch.speakerId === null ? 'unassigned' : patch.speakerId ?? before.speakerId,
        startMs: patch.startMs ?? before.startMs,
        endMs: patch.endMs ?? before.endMs,
        version: expectedVersion + 1,
      };
      return cloud(next, { version: expectedVersion + 1 });
    },
    async splitSegment(projectId: string, segmentId: string, expectedVersion: number, playheadMs: number) {
      calls.push({ method: 'splitSegment', args: [projectId, segmentId, expectedVersion, playheadMs] });
      const left = cloud({ ...before, endMs: playheadMs, sourceText: 'hello beautiful', translatedText: 'xin chao' }, { version: expectedVersion + 1 });
      const right = cloud(
        { ...before, id: splitChildId, startMs: playheadMs, sourceText: 'world', translatedText: 'the gioi', version: 1 },
        { splitParentId: segmentId, version: 1 },
      );
      return { left, right };
    },
    async restoreSplit(
      projectId: string,
      segmentId: string,
      expectedVersion: number,
      childSegmentId: string,
      expectedChildVersion: number,
      original: RestoreSegmentInput,
    ) {
      calls.push({ method: 'restoreSplit', args: [projectId, segmentId, expectedVersion, childSegmentId, expectedChildVersion, original] });
      return cloud({
        id: segmentId,
        speakerId: original.speakerId ?? 'unassigned',
        startMs: original.startMs,
        endMs: original.endMs,
        sourceText: original.sourceText,
        translatedText: original.translatedText,
        version: expectedVersion + 1,
      }, { version: expectedVersion + 1 });
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

  it('commits a split with the parent revision and canonical Worker-generated child id', async () => {
    const { deps, calls } = makeDeps();
    const mutation = await commitSegmentSplit('project-1', before, 2_000, deps);

    expect(calls).toEqual([
      { method: 'splitSegment', args: ['project-1', 's1', 2, 2_000] },
    ]);
    expect(mutation.kind).toBe('split');
    expect(mutation.originalBefore).toEqual(before);
    expect(mutation.leftAfter).toMatchObject({ id: 's1', endMs: 2_000, speakerId: 'unassigned', version: 3 });
    expect(mutation.rightAfter).toMatchObject({ id: 'worker-child-1', startMs: 2_000, speakerId: 'unassigned', version: 1 });
  });

  it('undoes only the touched field using the current canonical version', async () => {
    const fixture = makeDeps();
    const mutation: FieldMutation = {
      kind: 'fields',
      segmentId: 's1',
      fields: ['translatedText'],
      before: { ...before, translatedText: 'ban cu', version: 2 },
      after: { ...before, translatedText: 'ban moi', version: 3 },
    };
    const current = { ...mutation.after, sourceText: 'server-safe-source', version: 9 };

    const canonical = await persistUndo('project-1', mutation, projectWith(current), fixture.deps) as FieldMutation;

    expect(fixture.calls).toEqual([
      { method: 'patchSegment', args: ['project-1', 's1', 9, { translatedText: 'ban cu' }] },
    ]);
    expect(canonical.kind).toBe('fields');
    expect(canonical.before.version).toBe(10);
    expect(canonical.after).toEqual(current);
  });

  it('uses the current canonical version for both timing undo and timing redo', async () => {
    const fixture = makeDeps();
    const mutation: TimingMutation = {
      kind: 'timing',
      segmentId: 's1',
      before,
      after: { ...before, startMs: 1_200, endMs: 3_200, version: 3 },
    };
    const currentAfter = { ...mutation.after, version: 11 };

    const undone = await persistUndo('project-1', mutation, projectWith(currentAfter), fixture.deps) as TimingMutation;
    expect(fixture.calls[0]).toEqual({
      method: 'patchSegment',
      args: ['project-1', 's1', 11, { startMs: 1_000, endMs: 3_000 }],
    });
    expect(undone.before.version).toBe(12);
    expect(undone.after).toEqual(currentAfter);

    fixture.calls.length = 0;
    const currentBefore = { ...before, version: 12 };
    const redone = await persistRedo('project-1', mutation, projectWith(currentBefore), fixture.deps) as TimingMutation;
    expect(fixture.calls[0]).toEqual({
      method: 'patchSegment',
      args: ['project-1', 's1', 12, { startMs: 1_200, endMs: 3_200 }],
    });
    expect(redone.before).toEqual(currentBefore);
    expect(redone.after.version).toBe(13);
  });

  it('restores a split with the current parent and child versions', async () => {
    const fixture = makeDeps();
    const mutation: SplitMutation = await commitSegmentSplit('project-1', before, 2_000, fixture.deps);
    fixture.calls.length = 0;
    const currentLeft = { ...mutation.leftAfter, version: 8 };
    const currentRight = { ...mutation.rightAfter, version: 4 };

    const canonical = await persistUndo('project-1', mutation, projectWith(currentLeft, currentRight), fixture.deps) as SplitMutation;

    expect(fixture.calls).toEqual([{
      method: 'restoreSplit',
      args: ['project-1', 's1', 8, 'worker-child-1', 4, {
        startMs: 1_000,
        endMs: 3_000,
        sourceText: 'hello beautiful world',
        translatedText: 'xin chao the gioi',
        speakerId: null,
      }],
    }]);
    expect(canonical.originalBefore.version).toBe(9);
    expect(canonical.leftAfter).toEqual(currentLeft);
    expect(canonical.rightAfter).toEqual(currentRight);
  });

  it('redoes a split from the current parent revision and returns the fresh Worker child lineage', async () => {
    const fixture = makeDeps();
    const originalMutation = await commitSegmentSplit('project-1', before, 2_000, fixture.deps);
    fixture.setSplitChildId('worker-child-2');
    fixture.calls.length = 0;
    const currentRestored = { ...before, version: 12 };

    const replayed = await persistRedo('project-1', originalMutation, projectWith(currentRestored), fixture.deps) as SplitMutation;

    expect(fixture.calls).toEqual([
      { method: 'splitSegment', args: ['project-1', 's1', 12, 2_000] },
    ]);
    expect(replayed.originalBefore).toEqual(currentRestored);
    expect(replayed.leftAfter.version).toBe(13);
    expect(replayed.rightAfter.id).toBe('worker-child-2');
    expect(replayed.rightAfter.version).toBe(1);
  });
});
