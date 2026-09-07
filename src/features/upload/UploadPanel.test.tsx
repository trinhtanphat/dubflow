import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CloudJob } from '../projects/jobApi';
import { UploadPanel } from './UploadPanel';

function failedJob(): CloudJob {
  return {
    id: 'j1',
    projectId: 'p1',
    type: 'dubbing',
    status: 'failed',
    progress: 0.42,
    currentStep: 'transcribing',
    errorCode: 'ASR_FAILED',
    errorMessage: 'Provider down',
    retryCount: 0,
    createdAt: '2026-09-07T01:00:00Z',
    updatedAt: '2026-09-07T01:01:00Z',
  };
}

describe('UploadPanel durable job feedback', () => {
  it('renders persisted stage, progress and provider failure after upload has started processing', () => {
    const props = {
      job: failedJob(),
      onProcessStarted: vi.fn(),
    } as any;
    const html = renderToStaticMarkup(<UploadPanel {...props} />);
    expect(html).toContain('transcribing');
    expect(html).toContain('42%');
    expect(html).toContain('ASR_FAILED');
    expect(html).toContain('Provider down');
  });
});
