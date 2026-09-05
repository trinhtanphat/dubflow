import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

function projectListResponse(projects: unknown[] = []) {
  return new Response(JSON.stringify({ projects }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('YupVox studio', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(projectListResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the reference-matched dubbing workspace', () => {
    render(<App />);
    expect(screen.getByText('YupVox.Com')).toBeInTheDocument();
    expect(screen.getByText('Tải lên video')).toBeInTheDocument();
    expect(screen.getByText(/Nhân vật đã nhận diện/)).toBeInTheDocument();
    expect(screen.getByText('女主 - 林婉儿')).toBeInTheDocument();
    expect(screen.getByText('AI Dubbing Studio')).toBeInTheDocument();
    expect(screen.getByText('Tiếng Việt', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Hơn 3.500+ voices')).toBeInTheDocument();
    expect(screen.getByLabelText('Timeline đa track')).toBeInTheDocument();
  });

  it('selects a timeline segment and edits Vietnamese dubbing text', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Chuyện gì đã xảy ra?' }));
    const translation = screen.getByLabelText('Bản dịch tiếng Việt');
    expect(translation).toHaveValue('Chuyện gì đã xảy ra?');
    fireEvent.change(translation, { target: { value: 'Đã xảy ra chuyện gì vậy?' } });
    expect(translation).toHaveValue('Đã xảy ra chuyện gì vậy?');
  });

  it('surfaces project API failures instead of silently showing demo data as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Không thể kết nối API.')));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể kết nối API.');
  });

  it('uses the first persisted project title when the API returns projects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(projectListResponse([
      { id: 'p1', title: 'Dự án đã lưu', source_language: 'zh', target_language: 'vi', status: 'draft' },
    ])));
    render(<App />);
    expect(await screen.findByText('Dự án đã lưu')).toBeInTheDocument();
  });
});
