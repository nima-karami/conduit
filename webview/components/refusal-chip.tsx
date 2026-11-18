export interface RefusalChipData {
  count: number;
  latest: { id: string; at: string };
}

export function RefusalChip({
  data,
  sessionName,
  compact = false,
  onClick,
}: {
  data?: RefusalChipData;
  sessionName: string;
  compact?: boolean;
  onClick?: (latest: RefusalChipData['latest']) => void;
}) {
  if (!data || !onClick || !Number.isSafeInteger(data.count) || data.count <= 0 || !data.latest.id)
    return null;
  const time = new Date(data.latest.at);
  if (!Number.isFinite(time.getTime())) return null;
  const label = `${data.count} refused`;
  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
    time,
  );
  return (
    <button
      type="button"
      className={`refusal-chip${compact ? ' refusal-chip--compact' : ''}`}
      title={`Why was ${sessionName}'s request refused?`}
      aria-label={`Why was ${sessionName}'s request refused? ${label}, latest ${clock}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick(data.latest);
      }}
    >
      {!compact && <span aria-hidden="true">⚠ </span>}
      {label}
      {!compact && ` · ${clock}`}
    </button>
  );
}
