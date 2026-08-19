import { cn } from "@/lib/utils";
import type { IncidentData, IncidentStatus } from "@/lib/dashboard-data";

const DOT_CLASSES: Record<IncidentStatus, string> = {
  critical: "bg-status-critical",
  attention: "bg-status-attention",
  active: "bg-accent",
  stable: "bg-status-stable",
};

const TEXT_CLASSES: Record<IncidentStatus, string> = {
  critical: "text-status-critical",
  attention: "text-status-attention",
  active: "text-accent",
  stable: "text-status-stable",
};

export function IncidentRow({
  title,
  sessions,
  timeAgo,
  status,
  statusLabel,
}: IncidentData) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex items-start gap-3">
        <span
          className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT_CLASSES[status])}
          aria-hidden
        />
        <div>
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="text-xs text-ink-muted">
            {sessions} · {timeAgo}
          </p>
        </div>
      </div>
      <span
        className={cn(
          "text-sm font-medium whitespace-nowrap",
          TEXT_CLASSES[status],
        )}
      >
        {statusLabel}
      </span>
    </div>
  );
}
