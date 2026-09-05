import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>;

export function IconButton({ className = '', children, ...props }: Props) {
  return <button className={`icon-button ${className}`} type="button" {...props}>{children}</button>;
}
