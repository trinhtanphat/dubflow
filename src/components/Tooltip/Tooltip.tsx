import type { ReactNode } from 'react';

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return <span className="ui-tooltip" data-tooltip={text}>{children}</span>;
}
