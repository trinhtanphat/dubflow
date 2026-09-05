import type { ButtonHTMLAttributes, ReactNode } from 'react';

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: ReactNode;
};

export function IconButton({ label, icon, className = '', ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={`ui-icon-button ${className}`.trim()}
    >
      {icon}
    </button>
  );
}
