type IconButtonProps = { label: string; icon: string; disabled?: boolean };
export function IconButton({ label, icon, disabled = false }: IconButtonProps) {
  return <button className="icon-button" type="button" aria-label={label} title={label} disabled={disabled}><span aria-hidden="true">{icon}</span></button>;
}
