import type { PropsWithChildren, ReactNode } from 'react';

type Props = PropsWithChildren<{ title?: ReactNode; className?: string }>;

export function Panel({ title, className = '', children }: Props) {
  return <section className={`panel ${className}`}>{title ? <div className="panel-title">{title}</div> : null}{children}</section>;
}
