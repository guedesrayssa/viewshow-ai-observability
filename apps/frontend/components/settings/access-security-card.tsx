import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { ACCOUNT_PROFILE } from "@/lib/settings-data";

export function AccessSecurityCard() {
  return (
    <Card className="flex flex-1 flex-col">
      <CardTitle>Acesso e segurança</CardTitle>

      <div className="mt-5 flex flex-1 flex-col gap-5">
        <div>
          <p className="text-caption text-brand-blue">Método de entrada</p>
          <p className="text-body-sm font-medium text-ink">
            {ACCOUNT_PROFILE.authMethod} · autenticação corporativa
          </p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-caption text-brand-blue">Sessões ativas</p>
            <p className="text-body-sm font-medium text-ink">
              {ACCOUNT_PROFILE.activeSessions} dispositivos
            </p>
          </div>
          <Button variant="outline" size="sm">
            Encerrar sessões
          </Button>
        </div>
      </div>
    </Card>
  );
}
