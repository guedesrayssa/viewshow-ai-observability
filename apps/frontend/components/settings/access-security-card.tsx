"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAccount } from "@/components/account/account-provider";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";

export function AccessSecurityCard() {
  const { profile, signOut } = useAccount();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.push("/login");
    } finally {
      setSigningOut(false);
    }
  }

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

        <div className="mt-auto flex justify-end">
          <Button
            variant="outline"
            size="sm"
            loading={signingOut}
            onClick={handleSignOut}
          >
            Sair da conta
          </Button>
        </div>
      </div>
    </Card>
  );
}
