"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ACCOUNT_PROFILE, TEAM_OPTIONS, TIMEZONE_OPTIONS } from "@/lib/settings-data";

export function AccountDetailsCard() {
  const [name, setName] = useState(ACCOUNT_PROFILE.name);
  const [team, setTeam] = useState(TEAM_OPTIONS[0].value);
  const [timezone, setTimezone] = useState(TIMEZONE_OPTIONS[0].value);

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
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="E-mail corporativo"
          fieldSize="md"
          value={ACCOUNT_PROFILE.email}
          className="truncate"
          disabled
        />
        <div className="flex flex-col gap-2">
          <label className="block text-label text-ink-muted">Equipe</label>
          <Select
            aria-label="Equipe"
            fieldSize="md"
            value={team}
            onChange={(event) => setTeam(event.target.value)}
            className="w-full truncate"
          >
            {TEAM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <label className="block text-label text-ink-muted">
            Fuso horário
          </label>
          <Select
            aria-label="Fuso horário"
            fieldSize="md"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            className="w-full"
          >
            {TIMEZONE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <Button variant="solid">Salvar dados</Button>
      </div>
    </Card>
  );
}
