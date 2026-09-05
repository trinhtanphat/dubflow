import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('DubFlow studio', () => {
  it('renders the reference-matched dubbing workspace', () => {
    render(<App />);
    expect(screen.getByText('DubFlow')).toBeInTheDocument();
    expect(screen.getByText('Tải lên video')).toBeInTheDocument();
    expect(screen.getByText(/Nhân vật đã nhận diện/)).toBeInTheDocument();
    expect(screen.getByText('AI Dubbing Studio')).toBeInTheDocument();
    expect(screen.getByText('Tiếng Việt', { selector: 'strong' })).toBeInTheDocument();
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
});
