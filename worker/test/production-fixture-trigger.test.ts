import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../.github/workflows/production-media-fixture.yml', import.meta.url);

describe('production R2 fixture trigger coverage', () => {
  it('reruns the live media fixture when direct ASR runtime wiring changes', async () => {
    const source = await readFile(workflowUrl, 'utf8');

    expect(source).toContain("- 'worker/src/services/asr/workers-ai.ts'");
    expect(source).toContain("- 'worker/src/services/asr/types.ts'");
    expect(source).toContain("- 'worker/src/workflows/pipeline.ts'");
    expect(source).toContain("- 'worker/src/workflows/DubbingWorkflow.ts'");
  });
});
