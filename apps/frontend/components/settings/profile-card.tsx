/**
 * @file profile-card.tsx
 * Identificação da conta em sessão, com a foto do perfil.
 *
 * A foto é escolhida aqui e passa a valer na navegação e na barra superior na
 * mesma hora — não há botão de salvar, porque não há nada a confirmar: a
 * escolha da imagem já é a confirmação. Trocar por outra ou remover desfaz.
 */

"use client";

import { useRef, useState } from "react";

import { useAccount } from "@/components/account/account-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldError } from "@/components/ui/input";
import {
  ACCEPTED_IMAGE_TYPES,
  IMAGE_ERROR_MESSAGES,
  readSquareImage,
  type ImageError,
} from "@/lib/image";

export function ProfileCard() {
  const { profile, updateProfile } = useAccount();
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;

    setError(undefined);
    setWorking(true);

    try {
      updateProfile({ photo: await readSquareImage(file) });
    } catch (reason) {
      setError(
        IMAGE_ERROR_MESSAGES[reason as ImageError] ??
          IMAGE_ERROR_MESSAGES["leitura-falhou"],
      );
    } finally {
      setWorking(false);
      // Limpar o campo permite reenviar o mesmo arquivo depois de um erro.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card accent="brand" accentPosition="top">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <Avatar size="lg" />

          <div>
            <p className="text-title text-ink">{profile.name}</p>
            <a
              href={`mailto:${profile.email}`}
              className="text-body-sm text-ink-brand hover:underline"
            >
              {profile.email}
            </a>
            <p className="text-body-sm text-ink-muted">{profile.role}</p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                className="sr-only"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />

              <Button
                variant="outline"
                size="sm"
                loading={working}
                onClick={() => inputRef.current?.click()}
              >
                {profile.photo ? "Trocar foto" : "Enviar foto"}
              </Button>

              {profile.photo ? (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    setError(undefined);
                    updateProfile({ photo: null });
                  }}
                >
                  Remover
                </Button>
              ) : null}
            </div>

            {error ? (
              <FieldError className="mt-2">{error}</FieldError>
            ) : (
              <p className="mt-2 text-caption text-ink-subtle">
                JPEG, PNG ou WebP, até 8 MB. A imagem é cortada em quadrado.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col items-start gap-3 sm:items-end">
          <div className="flex gap-8 text-right">
            <div>
              <p className="text-caption text-ink-subtle">Autenticação</p>
              <p className="text-body-sm font-medium text-ink">
                {profile.authMethod}
              </p>
            </div>
            <div>
              <p className="text-caption text-ink-subtle">Último acesso</p>
              <p className="text-body-sm font-medium text-ink">
                {profile.lastAccess}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
