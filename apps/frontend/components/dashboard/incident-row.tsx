import { Badge } from "@/components/ui/badge";
import type { IncidentData } from "@/lib/dashboard-data";

export function IncidentRow({
  title,
  sessions,
  timeAgo,
  status,
  statusLabel,
}: IncidentData) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div>
        <p className="text-body-sm font-semibold text-ink">{title}</p>
        <p className="text-caption text-ink-muted">
          {sessions} · {timeAgo}
        </p>
      </div>
      <Badge tone={status} withDot>
        {statusLabel}
      </Badge>
    </div>
  );
}
