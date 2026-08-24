import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IncidentRow } from "@/components/dashboard/incident-row";
import { INCIDENTS } from "@/lib/dashboard-data";

export function IncidentsCard() {
  return (
    <Card
      accent="brand"
      accentPosition="top"
      className="flex w-full flex-col lg:w-96"
    >
      <CardTitle>Incidentes</CardTitle>
      <CardDescription>Priorizados por impacto</CardDescription>

      <div className="mt-2 divide-y divide-line">
        {INCIDENTS.map((incident) => (
          <IncidentRow key={incident.id} {...incident} />
        ))}
      </div>

      <Button variant="gradient" fullWidth className="mt-6">
        Ver todos
      </Button>
    </Card>
  );
}
