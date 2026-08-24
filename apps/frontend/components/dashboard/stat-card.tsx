import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import type { StatAccent, StatCardData } from "@/lib/dashboard-data";

const DELTA_CLASSES: Record<StatAccent, string> = {
  critical: "text-critical-strong",
  warning: "text-warning-strong",
  info: "text-ink-muted",
};

export function StatCard({ label, value, delta, accent, deltaTone }: StatCardData) {
  return (
    <Card accent={accent} className="flex-1">
      <CardDescription>{label}</CardDescription>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <CardTitle className="text-h2">{value}</CardTitle>
        <span
          className={`text-caption font-medium ${
            deltaTone === "accent" ? DELTA_CLASSES[accent] : "text-ink-muted"
          }`}
        >
          {delta}
        </span>
      </div>
    </Card>
  );
}
