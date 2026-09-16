"use client";

import { useAccount } from "@/components/account/account-provider";
import { Card, CardTitle } from "@/components/ui/card";

export function AccessSecurityCard() {
  const { profile } = useAccount();

  return (
    <Card className="flex flex-1 flex-col">
      <CardTitle>Acesso e segurança</CardTitle>

      <div className="mt-5 flex flex-1 flex-col gap-5">
        <div>
          <p className="text-caption text-ink-brand">Método de entrada</p>
          <p className="text-body-sm font-medium text-ink">
            {profile.authMethod}
          </p>
        </div>

        <div>
          <p className="text-caption text-ink-brand">Último acesso</p>
          <p className="text-body-sm font-medium text-ink">
            {profile.lastAccess}
          </p>
        </div>
      </div>
    </Card>
  );
}
