import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

export function DangerZoneCard() {
  return (
    <Card borderTone="critical" className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <CardTitle>Zona de risco</CardTitle>
        <p className="mt-1 max-w-2xl text-body-sm text-ink-muted">
          Excluir a conta remove preferências e histórico pessoal de feedback.
          A ação exige confirmação administrativa.
        </p>
      </div>
      <Button variant="gradient">Excluir conta</Button>
    </Card>
  );
}
