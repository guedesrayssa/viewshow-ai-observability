/**
 * @file account-details-card.tsx
 * Dados da conta usados para identificar ações e feedbacks em incidentes.
 *
 * O nome é editável e vale para toda a interface: é ele que assina a
 * confirmação de uma hipótese em Evidências e que aparece na navegação. Por
 * isso a alteração só vale ao salvar — diferente da foto, que não muda o
 * significado de nenhum registro.
 */

"use client";

import { useState } from "react";

import { useAccount } from "@/components/account/account-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TEAM_OPTIONS, TIMEZONE_OPTIONS } from "@/lib/settings-data";

export function AccountDetailsCard() {
  const { profile, updateProfile } = useAccount();

  const [name, setName] = useState(profile.name);
  const [team, setTeam] = useState(TEAM_OPTIONS[0].value);
  const [timezone, setTimezone] = useState(TIMEZONE_OPTIONS[0].value);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const dirty = name.trim() !== profile.name;

  function save() {
    const trimmed = name.trim();

    if (!trimmed) {
      setError("Informe o nome que deve assinar as suas ações.");
      return;
    }

    setError(undefined);
    updateProfile({ name: trimmed });
    setName(trimmed);
    setSaved(true);
  }

  return (
    <Card className="flex flex-1 flex-col">
      <CardTitle>Dados da conta</CardTitle>
      <CardDescription>
        Informações usadas para identificar ações e feedbacks em incidentes
      </CardDescription>

      <div className="mt-5 grid flex-1 gap-5 sm:grid-cols-2">
        <TextField
          label="Nome"
          fieldSize="md"
          value={name}
          error={error}
          hint="Assina as hipóteses que você confirma ou refuta"
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
            setSaved(false);
          }}
        />
        <TextField
          label="E-mail corporativo"
          fieldSize="md"
          value={profile.email}
          className="truncate"
          hint="Definido pelo provedor de identidade"
          disabled
        />
        <div className="flex flex-col gap-2">
          <label className="block text-label text-ink-muted">Equipe</label>
          <Select
            aria-label="Equipe"
            fieldSize="md"
            value={team}
            onValueChange={setTeam}
            className="w-full truncate"
            options={TEAM_OPTIONS}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="block text-label text-ink-muted">Fuso horário</label>
          <Select
            aria-label="Fuso horário"
            fieldSize="md"
            value={timezone}
            onValueChange={setTimezone}
            className="w-full"
            options={TIMEZONE_OPTIONS}
          />
        </div>
      </div>

      {saved && !dirty ? (
        <Alert tone="success" className="mt-5">
          Dados salvos. O novo nome já aparece na navegação.
        </Alert>
      ) : null}

      <div className="mt-5 flex justify-end">
        <Button variant="solid" disabled={!dirty} onClick={save}>
          Salvar dados
        </Button>
      </div>
    </Card>
  );
}
