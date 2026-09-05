import type { PropsWithChildren, ReactNode } from 'react';

export function TimelineTrack({ label, children }: PropsWithChildren<{ label: ReactNode }>) {
  return <div className="timeline-row"><div className="track-label">{label}</div><div className="track-content">{children}</div></div>;
}
