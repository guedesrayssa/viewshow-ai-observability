import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { StatAccent, StatCardData } from "@/lib/dashboard-data";

const ACCENT_COLORS: Record<StatAccent, string> = {
  danger: "var(--danger)",
  warning: "var(--warning)",
  info: "var(--accent)",
};

const DELTA_CLASSES: Record<StatAccent, string> = {
  danger: "text-danger",
  warning: "text-warning",
  info: "text-ink-muted",
};

export function StatCard({
  label,
  value,
  delta,
  accent,
  deltaTone,
}: StatCardData) {
  return (
    <Card leftAccentColor={ACCENT_COLORS[accent]} className="flex-1">
      <p className="text-sm font-medium text-accent">{label}</p>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="text-3xl font-semibold text-ink">{value}</span>
        <span
          className={cn(
            "text-xs font-medium",
            deltaTone === "accent" ? DELTA_CLASSES[accent] : "text-ink-muted",
          )}
        >
          {delta}
        </span>
      </div>
    </Card>
  );
}
