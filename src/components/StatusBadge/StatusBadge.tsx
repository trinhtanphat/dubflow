export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

type StatusBadgeProps = {
  label: string;
  tone?: StatusTone;
  detail?: string;
};

export function StatusBadge({ label, tone = 'neutral', detail }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <i aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </span>
  );
}
