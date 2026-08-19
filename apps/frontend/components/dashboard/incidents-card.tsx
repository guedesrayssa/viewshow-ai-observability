import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IncidentRow } from "@/components/dashboard/incident-row";
import { INCIDENTS } from "@/lib/dashboard-data";

export function IncidentsCard() {
  return (
    <Card topAccent className="flex w-full flex-col lg:w-96">
      <h2 className="text-lg font-semibold text-ink">Incidentes</h2>
      <p className="text-sm text-accent">Priorizados por impacto</p>

      <div className="mt-2 divide-y divide-border">
        {INCIDENTS.map((incident) => (
          <IncidentRow key={incident.id} {...incident} />
        ))}
      </div>

      <Button className="mt-6 w-full">Ver todos</Button>
    </Card>
  );
}
